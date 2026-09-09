import { COLORS, cssColor, type GameColor } from "./colors.ts";
import type {
  ChatKind,
  ChatMessage,
  LobbySummary,
  Phase,
  Player,
  PublicPlayer,
  Winner,
} from "./types.ts";
import {
  CHAT_SYSTEM,
  COORD_SYSTEM,
  generate,
  KILL_SYSTEM,
  NIGHT_SYSTEM,
  VOTE_SYSTEM,
} from "./ai.ts";
import { availableModels, getModel, randomModel } from "./models.ts";
import { recordGame } from "./stats.ts";
import { memoryBlock, recordOutcome } from "./memory.ts";
import { searchGifs } from "./klipy.ts";

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 15;

const DAY_MS = 30_000;
const VOTE_MS = 20_000;
const REVEAL_MS = 6_000;
const NIGHT_MS = 10_000;
const RESET_MS = 12_000;
const LOBBY_GRACE_MS = 25_000;


const LINK_RE =
  /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*\.[a-z]{2,24}\/\S*|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|gg|co|me|ly|xyz|ru|tk|link|app|dev|tv|to|cc|info|biz|site|online|shop|gl|be|ai|sh|st|im|fun|club|top|live|store)\b/gi;

function stripLinks(text: string): string {
  return text.replace(LINK_RE, "").replace(/\s{2,}/g, " ").trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Room {
  code: string;
  hostId = "";
  modelId: string;
  isPublic: boolean;
  maxPlayers: number;
  lastSeen = Date.now();
  lobbyMemory = false;
  aiCount: number | null = null;
  aiModels: string[] = [];
  private lessonsByScope = new Map<string, string>();
  phase: Phase = "lobby";
  day = 0;
  winner: Winner = null;
  phaseEndsAt = 0;
  players = new Map<string, Player>();
  messages: ChatMessage[] = [];
  votes = new Map<string, string>();
  private lastVoteAt = new Map<string, number>();
  private running = false;
  private aiMessageCount = 0;
  private aiEjectedCount = 0;

  constructor(code: string, isPublic = false, maxPlayers = MAX_PLAYERS) {
    this.code = code;
    this.isPublic = isPublic;
    this.maxPlayers = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.floor(maxPlayers)));
    this.modelId = randomModel().id;
  }

  get connectedHumans(): Player[] {
    return this.humans.filter((p) => p.connected);
  }

  summary(): LobbySummary {
    return {
      code: this.code,
      players: this.humans.length,
      maxPlayers: this.maxPlayers,
      modelLabel: this.modelSummaryLabel(),
      hostName: this.players.get(this.hostId)?.name ?? "?",
    };
  }

  modelSummaryLabel(): string {
    const labels = new Set(
      this.seatModels(this.effectiveAiCount()).map((id) => getModel(id).label),
    );
    if (labels.size === 1) return [...labels][0];
    return `Mixed (${labels.size})`;
  }

  get list(): Player[] {
    return [...this.players.values()];
  }

  get humans(): Player[] {
    return this.list.filter((p) => !p.isAI);
  }

  get alive(): Player[] {
    return this.list.filter((p) => p.alive);
  }

  get aliveAIs(): Player[] {
    return this.alive.filter((p) => p.isAI);
  }

  get aliveHumans(): Player[] {
    return this.alive.filter((p) => !p.isAI);
  }

  private freeColor(): GameColor {
    const used = new Set(this.list.map((p) => p.color.name));
    const free = COLORS.filter((c) => !used.has(c.name));
    const pool = free.length > 0 ? free : COLORS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  addPlayer(name: string, socket: WebSocket): Player | null {
    if (this.phase !== "lobby") return null;
    const clean = name.slice(0, 20);
    for (const q of this.humans) {
      if (!q.connected && q.name === clean) {
        this.players.delete(q.id);
        if (this.hostId === q.id) this.hostId = "";
      }
    }
    if (this.humans.length >= this.maxPlayers) return null;
    const player: Player = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      name: clean,
      color: this.freeColor(),
      isAI: false,
      alive: true,
      modelId: null,
      connected: true,
      socket,
    };
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    this.lastSeen = Date.now();
    return player;
  }

  resume(token: string, socket: WebSocket): Player | null {
    const p = this.list.find((q) => !q.isAI && q.token === token);
    if (!p) return null;
    const previous = p.socket;
    if (previous && previous !== socket && previous.readyState === WebSocket.OPEN) {
      try {
        previous.close();
      } catch { /* already closing */ }
    }
    p.socket = socket;
    p.connected = true;
    this.lastSeen = Date.now();
    if (!this.players.has(this.hostId) || !this.players.get(this.hostId)?.connected) {
      this.hostId = this.connectedHumans[0]?.id ?? this.hostId;
    }
    this.pushState();
    return p;
  }

  markDisconnected(id: string, socket?: WebSocket) {
    const p = this.players.get(id);
    if (!p) return;
    if (socket && p.socket && p.socket !== socket) return;
    if (!p.connected) return;
    p.connected = false;
    p.socket = null;
    if (this.hostId === id) this.hostId = this.connectedHumans[0]?.id ?? "";
    this.pushState();
    if (this.phase === "lobby") {
      setTimeout(() => {
        const q = this.players.get(id);
        if (q && !q.connected && this.phase === "lobby") {
          this.players.delete(id);
          if (this.hostId === id) this.hostId = this.connectedHumans[0]?.id ?? "";
          this.pushState();
        }
      }, LOBBY_GRACE_MS);
    }
  }

  setLearn(id: string, on: boolean) {
    if (id !== this.hostId || this.phase !== "lobby") return;
    this.lobbyMemory = on;
    this.pushState();
  }

  private scopeFor(bot: Player): string {
    return this.lobbyMemory ? `lobby-${this.code}` : (bot.modelId ?? this.modelId);
  }

  private scopeLabel(scope: string): string {
    return this.lobbyMemory ? `Lobby ${this.code}` : getModel(scope).label;
  }

  autoAiCount(): number {
    return Math.max(1, Math.floor(this.humans.length / 3));
  }

  effectiveAiCount(): number {
    const wanted = this.aiCount ?? this.autoAiCount();
    const ceiling = Math.max(1, Math.min(5, this.humans.length - 1));
    return Math.max(1, Math.min(wanted, ceiling));
  }

  seatModels(count: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const wanted = this.aiModels[i];
      out.push(availableModels().some((m) => m.id === wanted) ? wanted : this.modelId);
    }
    return out;
  }

  setAiCount(id: string, n: number) {
    if (id !== this.hostId || this.phase !== "lobby") return;
    if (!Number.isFinite(n)) return;
    this.aiCount = Math.max(1, Math.min(5, Math.floor(n)));
    this.pushState();
  }

  setAiModels(id: string, ids: string[]) {
    if (id !== this.hostId || this.phase !== "lobby") return;
    this.aiModels = ids.slice(0, 5).map((x) => String(x));
    this.pushState();
  }

  setVisibility(id: string, isPublic: boolean) {
    if (id !== this.hostId || this.phase !== "lobby") return;
    this.isPublic = isPublic;
    this.pushState();
  }

  setModel(id: string, modelId: string) {
    if (id !== this.hostId || this.phase !== "lobby") return;
    if (!availableModels().some((m) => m.id === modelId)) return;
    this.modelId = modelId;
    this.pushState();
  }

  send(p: Player, data: unknown) {
    if (p.socket && p.socket.readyState === WebSocket.OPEN) {
      try {
        p.socket.send(JSON.stringify(data));
      } catch {
        p.connected = false;
      }
    }
  }

  private pushMessage(msg: ChatMessage) {
    this.messages.push(msg);
    if (this.messages.length > 400) this.messages.shift();
    for (const p of this.humans) {
      if (msg.kind === "ai_private" && p.alive && this.phase !== "over") continue;
      this.send(p, { t: "msg", msg });
    }
  }

  private say(kind: ChatKind, text: string, from?: Player) {
    this.pushMessage({
      id: crypto.randomUUID(),
      playerId: from?.id ?? null,
      colorName: from ? from.color.name : null,
      colorCss: from ? cssColor(from.color) : null,
      kind,
      text,
      day: this.day,
      ts: Date.now(),
    });
  }

  publicView(viewer: Player): PublicPlayer[] {
    const revealAll = this.phase === "over" || !viewer.alive;
    const inLobby = this.phase === "lobby";
    return this.list.map((p) => {
      const base: PublicPlayer = {
        id: p.id,
        colorName: p.color.name,
        colorCss: cssColor(p.color),
        alive: p.alive,
        connected: p.isAI || p.connected,
      };
      if (inLobby || revealAll || p.id === viewer.id) base.name = p.name;
      if (revealAll) {
        base.isAI = p.isAI;
        base.modelId = p.modelId;
      }
      return base;
    });
  }

  stateFor(viewer: Player) {
    return {
      t: "state",
      code: this.code,
      phase: this.phase,
      day: this.day,
      endsAt: this.phaseEndsAt,
      hostId: this.hostId,
      modelId: this.modelId,
      modelLabel: this.modelSummaryLabel(),
      winner: this.winner,
      minPlayers: MIN_PLAYERS,
      maxPlayers: this.maxPlayers,
      isPublic: this.isPublic,
      lobbyMemory: this.lobbyMemory,
      aiCount: this.effectiveAiCount(),
      aiModels: this.seatModels(this.effectiveAiCount()),
      you: {
        id: viewer.id,
        name: viewer.name,
        colorName: viewer.color.name,
        colorCss: cssColor(viewer.color),
        alive: viewer.alive,
      },
      players: this.publicView(viewer),
      votes: this.phase === "vote" ? this.voteTally() : null,
    };
  }

  pushState() {
    for (const p of this.humans) this.send(p, this.stateFor(p));
  }

  sendHistory(p: Player) {
    const visible = this.messages.filter(
      (m) => m.kind !== "ai_private" || !p.alive || this.phase === "over",
    );
    this.send(p, { t: "history", messages: visible });
  }

  chat(id: string, text: string) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.phase === "over" || this.phase === "lobby") return;
    const clean = stripLinks(text).slice(0, 300);
    if (!clean) return;
    this.say("chat", clean, p);
  }

  gif(id: string, url: string) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.phase === "over" || this.phase === "lobby") return;
    if (!url.startsWith("https://")) return;
    this.say("gif", url.slice(0, 500), p);
  }

  vote(id: string, target: string) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.phase !== "vote") return;
    if (target !== "skip" && !this.players.get(target)?.alive) return;
    if (this.votes.get(id) === target) return;
    if (Date.now() - (this.lastVoteAt.get(id) ?? 0) < 1500) return;
    this.lastVoteAt.set(id, Date.now());
    this.votes.set(id, target);
    this.announceVote(p, target);
    this.pushState();
  }

  private announceVote(voter: Player, target: string) {
    const t = target === "skip" ? null : this.players.get(target);
    this.say("system", `${voter.color.name} voted ${t ? `for ${t.color.name}` : "to skip"}.`);
  }

  private voteTally(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const v of this.votes.values()) out[v] = (out[v] ?? 0) + 1;
    return out;
  }

  start(id: string) {
    if (id !== this.hostId || this.phase !== "lobby" || this.running) return;
    if (this.humans.length < MIN_PLAYERS) return;
    const aiCount = this.effectiveAiCount();
    const seats = this.seatModels(aiCount);
    const labelTotals = new Map<string, number>();
    for (const id of seats) {
      const label = getModel(id).label;
      labelTotals.set(label, (labelTotals.get(label) ?? 0) + 1);
    }
    const labelSeen = new Map<string, number>();
    for (let i = 0; i < aiCount; i++) {
      const modelId = seats[i];
      const label = getModel(modelId).label;
      const n = (labelSeen.get(label) ?? 0) + 1;
      labelSeen.set(label, n);
      const bot: Player = {
        id: crypto.randomUUID(),
        token: crypto.randomUUID(),
        name: (labelTotals.get(label) ?? 1) > 1 ? `${label} ${n}` : label,
        color: this.freeColor(),
        isAI: true,
        alive: true,
        modelId,
        connected: true,
        socket: null,
      };
      this.players.set(bot.id, bot);
    }
    this.messages = [];
    this.day = 0;
    this.winner = null;
    this.aiMessageCount = 0;
    this.aiEjectedCount = 0;
    this.running = true;
    for (const p of this.list) p.alive = true;
    this.reshuffleColors();
    this.lessonsByScope.clear();
    for (const scope of new Set(this.list.filter((p) => p.isAI).map((p) => this.scopeFor(p)))) {
      memoryBlock(scope, this.scopeLabel(scope))
        .then((b) => this.lessonsByScope.set(scope, b))
        .catch(() => this.lessonsByScope.set(scope, ""));
    }
    this.loop();
  }

  private transcript(limit = 30): string {
    return this.messages
      .filter((m) => m.kind === "chat" || m.kind === "system")
      .slice(-limit)
      .map((m) => (m.colorName ? `${m.colorName}: ${m.text}` : `[${m.text}]`))
      .join("\n");
  }

  private privateTranscript(limit = 12): string {
    return this.messages
      .filter((m) => m.kind === "ai_private")
      .slice(-limit)
      .map((m) => `${m.colorName}: ${m.text}`)
      .join("\n");
  }

  private isOver(): boolean {
    return this.phase === "over";
  }

  private async loop() {
    while (!this.isOver()) {
      await this.dayPhase();
      if (this.isOver()) break;
      await this.votePhase();
      if (this.checkWin()) break;
      await this.nightPhase();
      if (this.checkWin()) break;
    }
    this.running = false;
  }

  private setPhase(phase: Phase, ms: number) {
    this.phase = phase;
    this.phaseEndsAt = Date.now() + ms;
    this.pushState();
  }

  private reshuffleColors() {
    const pool = shuffle(COLORS);
    this.list.forEach((p, i) => {
      p.color = pool[i % pool.length];
    });
  }

  private async findGif(query: string): Promise<string | null> {
    const q = query.replace(/[^A-Za-z0-9 ]/g, "").trim();
    if (!q) return null;
    const gifs = await searchGifs(q, `room-${this.code}`);
    if (gifs.length === 0) return null;
    return gifs[Math.floor(Math.random() * Math.min(gifs.length, 8))].url;
  }

  private chatCount(): number {
    return this.messages.filter((m) => m.kind === "chat").length;
  }

  private async dayPhase() {
    this.day += 1;
    this.votes.clear();
    this.setPhase("day", DAY_MS);
    this.say("system", `Day ${this.day}. ${this.alive.length} players remain.`);
    const deadline = this.phaseEndsAt;
    this.aiCoordinate("day").catch((e) => console.error("[coord]", e));
    for (const bot of this.aliveAIs) this.aiChatter(bot, deadline, "day", 3);
    await sleep(DAY_MS);
  }

  private async aiCoordinate(phase: Phase) {
    const bots = this.aliveAIs;
    if (bots.length < 2) return;
    for (const bot of bots) {
      if (this.phase !== phase || !bot.alive) return;
      const allies = bots.filter((p) => p.id !== bot.id).map((p) => p.color.name).join(", ");
      const targets = this.aliveHumans.map((p) => p.color.name).join(", ");
      const priv = this.privateTranscript(8) || "(no plan yet)";
      const stage = phase === "vote" ? "Voting is open now." : "Open discussion is running.";
      const prompt = [
        `You are ${bot.color.name}. Your fellow AI are: ${allies}.`,
        `Humans still alive: ${targets}.`,
        stage,
        "",
        "Public chat:",
        this.transcript(20),
        "",
        "Team channel so far:",
        priv,
        "",
        "Your line:",
      ].join("\n");
      const text = await generate(bot.modelId ?? "", COORD_SYSTEM, prompt, 90);
      if (text && this.phase === phase) this.say("ai_private", text.slice(0, 300), bot);
      await sleep(400);
    }
  }

  private aiChatter(bot: Player, deadline: number, phase: Phase, cap: number) {
    (async () => {
      let spoken = 0;
      let seen = this.chatCount();
      while (this.phase === phase && bot.alive && Date.now() < deadline - 2500) {
        await sleep(2000 + Math.random() * 4000);
        if (this.phase !== phase || !bot.alive || Date.now() > deadline - 2500) return;
        if (spoken >= cap) return;
        const count = this.chatCount();
        const fresh = count - seen;
        seen = count;
        if (fresh === 0 && spoken > 0) continue;
        const lastForeign = [...this.messages].reverse().find(
          (m) => m.kind === "chat" && m.playerId !== bot.id,
        );
        if (lastForeign && lastForeign.text.includes("?") && Date.now() - lastForeign.ts < 5000) {
          continue;
        }
        const roster = this.alive.map((p) => p.color.name).join(", ");
        const body = this.transcript() || "(nobody has spoken yet)";
        const situation = fresh === 0
          ? "Nobody has spoken since you last checked."
          : `${fresh} new message(s) since you last checked.`;
        const duty = spoken === 0 && phase === "day"
          ? "You have not spoken at all this round. You must reply with a message, not PASS."
          : `You have sent ${spoken} message(s) this round.`;
        const stage = phase === "vote"
          ? "Voting is open right now and people are deciding who to eject."
          : "This is the open discussion.";
        const lessons = this.lessonsByScope.get(this.scopeFor(bot)) ?? "";
        const past = lessons ? `\n${lessons}\n` : "";
        const plan = this.aliveAIs.length > 1 ? this.privateTranscript(6) : "";
        const secret = plan
          ? `\nPrivate AI channel, only your team sees this:\n${plan}\nAct on it. Never reveal it.\n`
          : "";
        const splitTurn = Math.random() < 0.18;
        const splitNote = splitTurn
          ? "Split this reply into two or three quick messages, one per line.\n"
          : "";
        const prompt = `You are ${bot.color.name}. Day ${this.day}. Players alive: ${roster}.\n` +
          `${stage} ${situation} ${duty}\n${splitNote}${past}${secret}\n` +
          `Chat so far:\n${body}\n\nPASS or your message:`;
        const text = await generate(bot.modelId ?? "", CHAT_SYSTEM, prompt, 120);
        if (this.phase !== phase || !bot.alive) return;
        const clean = text.replace(/^["']+|["']+$/g, "").trim();
        if (!clean) continue;
        if (/^pass\b/i.test(clean) || /^pass$/i.test(clean)) continue;
        const gifMatch = clean.match(/^gif:\s*(.{2,40})$/i);
        if (gifMatch) {
          const url = await this.findGif(gifMatch[1]);
          if (!url) continue;
          await sleep(1200 + Math.random() * 1800);
          if (this.phase !== phase || !bot.alive) return;
          spoken += 1;
          this.aiMessageCount += 1;
          this.say("gif", url, bot);
          seen = this.chatCount();
          continue;
        }
        const bursts: { text: string; slow: boolean }[] = [];
        let pause = false;
        for (const raw of clean.split("\n")) {
          const line = raw.trim();
          if (!line) {
            pause = true;
            continue;
          }
          bursts.push({ text: line.slice(0, 300), slow: pause });
          pause = false;
          if (bursts.length === 3) break;
        }
        for (let i = 0; i < bursts.length; i++) {
          const part = bursts[i];
          if (this.phase !== phase || !bot.alive) return;
          const wait = i === 0
            ? Math.min(6500, 800 + part.text.length * 38) + Math.random() * 700
            : part.slow
            ? 1200 + Math.random() * 1400
            : 260 + part.text.length * 22 + Math.random() * 340;
          await sleep(wait);
          if (this.phase !== phase || !bot.alive) return;
          const said = this.messages
            .filter((m) => m.kind === "chat" && m.playerId === bot.id)
            .slice(-3)
            .map((m) => m.text.toLowerCase());
          if (said.includes(part.text.toLowerCase())) continue;
          spoken += 1;
          this.aiMessageCount += 1;
          this.say("chat", part.text, bot);
        }
        seen = this.chatCount();
      }
    })();
  }

  private async votePhase() {
    this.votes.clear();
    this.lastVoteAt.clear();
    this.setPhase("vote", VOTE_MS);
    this.say("system", "Voting is open. Choose who to eject, or skip.");
    const voteDeadline = this.phaseEndsAt;
    this.aiCoordinate("vote").catch((e) => console.error("[coord]", e));
    for (const bot of this.aliveAIs) {
      this.aiVote(bot);
      this.aiChatter(bot, voteDeadline, "vote", 2);
    }
    await sleep(VOTE_MS);
    await this.resolveVote();
  }

  private aiVote(bot: Player) {
    (async () => {
      await sleep(2000 + Math.random() * (VOTE_MS - 6000));
      if (this.phase !== "vote" || !bot.alive) return;
      const options = this.alive.filter((p) => p.id !== bot.id).map((p) => p.color.name);
      const allies = this.aliveAIs.filter((p) => p.id !== bot.id).map((p) => p.color.name);
      const plan = this.aliveAIs.length > 1 ? this.privateTranscript(8) : "";
      const teamPlan = plan ? `Your team channel:\n${plan}\nVote with your team.\n\n` : "";
      const prompt = `You are ${bot.color.name}. Your fellow AI players are: ` +
        `${allies.join(", ") || "none"}.\nNever vote for a fellow AI.\n` +
        `Options: ${options.join(", ")}, SKIP\n\n${teamPlan}` +
        `Chat:\n${this.transcript()}\n\nYour vote:`;
      const raw = await generate(bot.modelId ?? "", VOTE_SYSTEM, prompt, 20);
      const answer = raw.trim().toLowerCase();
      const match = this.alive.find(
        (p) => !p.isAI && answer.includes(p.color.name.toLowerCase()),
      );
      const fallback = shuffle(this.aliveHumans)[0];
      const target = match ?? (answer.includes("skip") ? null : fallback);
      if (this.phase !== "vote") return;
      const choice = target ? target.id : "skip";
      if (this.votes.get(bot.id) === choice) return;
      this.votes.set(bot.id, choice);
      this.announceVote(bot, choice);
      this.pushState();
    })();
  }

  private async resolveVote() {
    const tally = this.voteTally();
    let top: string | null = null;
    let topN = 0;
    let tied = false;
    for (const [k, n] of Object.entries(tally)) {
      if (n > topN) {
        top = k;
        topN = n;
        tied = false;
      } else if (n === topN) {
        tied = true;
      }
    }
    this.setPhase("reveal", REVEAL_MS);
    if (!top || top === "skip" || tied || topN === 0) {
      this.say("system", "The vote was inconclusive. Nobody was ejected.");
    } else {
      const victim = this.players.get(top);
      if (victim) {
        victim.alive = false;
        if (victim.isAI) this.aiEjectedCount += 1;
        const role = victim.isAI ? "an AI" : "human";
        this.say("system", `${victim.color.name} was ejected. They were ${role}.`);
      }
    }
    this.pushState();
    await sleep(REVEAL_MS);
  }

  private async nightPhase() {
    this.setPhase("night", NIGHT_MS);
    this.say("system", "Night falls. The survivors go quiet.");
    const bots = this.aliveAIs;
    const rounds = bots.length > 1 ? 1 : 0;
    for (let r = 0; r < rounds; r++) {
      for (const bot of bots) {
        if (this.phase !== "night") return;
        const targets = this.aliveHumans.map((p) => p.color.name).join(", ");
        const priv = this.privateTranscript() || "(nothing yet)";
        const prompt = `You are ${bot.color.name}. Humans still alive: ${targets}.\n\n` +
          `Today's public chat:\n${this.transcript(20)}\n\n` +
          `Private AI discussion so far:\n${priv}\n\nYour line:`;
        const text = await generate(bot.modelId ?? "", NIGHT_SYSTEM, prompt, 100);
        if (text) this.say("ai_private", text.slice(0, 300), bot);
        await sleep(600);
      }
    }
    const decider = bots[0];
    let victim = shuffle(this.aliveHumans)[0];
    if (decider && this.aliveHumans.length > 1) {
      const targets = this.aliveHumans.map((p) => p.color.name).join(", ");
      const prompt = `Humans alive: ${targets}\n\nDiscussion:\n${this.privateTranscript()}\n\n` +
        `Target:`;
      const raw = await generate(decider.modelId ?? "", KILL_SYSTEM, prompt, 20);
      const answer = raw.trim().toLowerCase();
      victim = this.aliveHumans.find((p) => answer.includes(p.color.name.toLowerCase())) ?? victim;
    }
    if (victim) {
      victim.alive = false;
      this.say("system", `${victim.color.name} did not survive the night.`);
    }
    this.pushState();
    await sleep(2500);
  }

  private checkWin(): boolean {
    const ai = this.aliveAIs.length;
    const humans = this.aliveHumans.length;
    if (ai === 0) return this.endGame("humans");
    if (ai >= humans) return this.endGame("ai");
    return false;
  }

  private endGame(winner: Winner): boolean {
    this.winner = winner;
    this.phase = "over";
    this.phaseEndsAt = Date.now() + RESET_MS;
    this.say(
      "system",
      winner === "humans"
        ? "Every AI has been ejected. The humans win."
        : "The AI now equal the humans. The AI win.",
    );
    this.pushState();
    for (const p of this.humans) this.sendHistory(p);
    const bots = this.list.filter((p) => p.isAI);
    const aiWon = winner === "ai";
    const byModel = new Map<string, Player[]>();
    for (const b of bots) {
      const mid = b.modelId ?? this.modelId;
      byModel.set(mid, [...(byModel.get(mid) ?? []), b]);
    }
    const share = bots.length > 0 ? this.aiMessageCount / bots.length : 0;
    for (const [mid, seats] of byModel) {
      recordGame(mid, {
        aiWon,
        aiSeats: seats.length,
        aiEjected: seats.filter((b) => !b.alive).length,
        messagesSent: Math.round(share * seats.length),
      }).catch((e) => console.error("[stats]", e));
    }
    const scopes = new Map<string, string>();
    for (const b of bots) scopes.set(this.scopeFor(b), b.modelId ?? this.modelId);
    for (const [scope, mid] of scopes) {
      recordOutcome({
        scope,
        label: this.scopeLabel(scope),
        modelId: mid,
        aiWon,
        transcript: this.transcript(40),
        aiColors: bots.map((p) => p.color.name).join(", "),
      }).catch((e) => console.error("[memory]", e));
    }
    setTimeout(() => this.resetToLobby(), RESET_MS);
    return true;
  }

  resetToLobby() {
    for (const p of this.list) {
      if (p.isAI) this.players.delete(p.id);
      else if (!p.connected) this.players.delete(p.id);
      else p.alive = true;
    }
    this.lastSeen = Date.now();
    this.modelId = randomModel().id;
    this.phase = "lobby";
    this.day = 0;
    this.winner = null;
    this.votes.clear();
    this.messages = [];
    this.running = false;
    if (!this.players.has(this.hostId)) this.hostId = this.humans[0]?.id ?? "";
    this.pushState();
    for (const p of this.humans) this.sendHistory(p);
  }
}
