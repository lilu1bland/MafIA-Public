import { COLORS, cssColor, type GameColor } from "./colors.ts";
import type { ChatKind, ChatMessage, Phase, Player, PublicPlayer, Winner } from "./types.ts";
import { CHAT_SYSTEM, generate, KILL_SYSTEM, NIGHT_SYSTEM, VOTE_SYSTEM } from "./ai.ts";
import { availableModels, getModel, randomModel } from "./models.ts";
import { recordGame } from "./stats.ts";

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 15;

const DAY_MS = 30_000;
const VOTE_MS = 20_000;
const REVEAL_MS = 6_000;
const NIGHT_MS = 10_000;
const RESET_MS = 12_000;

const AI_NAMES = [
  "jules",
  "mika",
  "sam",
  "noor",
  "kai",
  "ren",
  "toby",
  "alex",
  "quinn",
  "robin",
  "esme",
  "ivo",
  "nadia",
  "wren",
  "dev",
];

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

  constructor(code: string) {
    this.code = code;
    this.modelId = randomModel().id;
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
    if (this.humans.length >= MAX_PLAYERS) return null;
    const player: Player = {
      id: crypto.randomUUID(),
      name: name.slice(0, 20),
      color: this.freeColor(),
      isAI: false,
      alive: true,
      modelId: null,
      connected: true,
      socket,
    };
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    return player;
  }

  removePlayer(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === "lobby") {
      this.players.delete(id);
      if (this.hostId === id) this.hostId = this.humans[0]?.id ?? "";
    } else {
      p.connected = false;
      p.socket = null;
    }
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
      modelLabel: getModel(this.modelId).label,
      winner: this.winner,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
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
    const clean = text.trim().slice(0, 300);
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
    const aiCount = Math.max(1, Math.floor(this.humans.length / 3));
    const names = shuffle(AI_NAMES);
    for (let i = 0; i < aiCount; i++) {
      const bot: Player = {
        id: crypto.randomUUID(),
        name: names[i] ?? `bot${i}`,
        color: this.freeColor(),
        isAI: true,
        alive: true,
        modelId: this.modelId,
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

  private chatCount(): number {
    return this.messages.filter((m) => m.kind === "chat").length;
  }

  private async dayPhase() {
    this.day += 1;
    this.votes.clear();
    this.reshuffleColors();
    this.setPhase("day", DAY_MS);
    this.say("system", `Day ${this.day}. ${this.alive.length} remain. Colours have been reshuffled.`);
    const deadline = this.phaseEndsAt;
    for (const bot of this.aliveAIs) this.aiChatter(bot, deadline);
    await sleep(DAY_MS);
  }

  private aiChatter(bot: Player, deadline: number) {
    (async () => {
      let spoken = 0;
      let seen = this.chatCount();
      while (this.phase === "day" && bot.alive && Date.now() < deadline - 2500) {
        await sleep(2000 + Math.random() * 4000);
        if (this.phase !== "day" || !bot.alive || Date.now() > deadline - 2500) return;
        if (spoken >= 3) return;
        const count = this.chatCount();
        const fresh = count - seen;
        seen = count;
        if (fresh === 0 && spoken > 0) continue;
        const roster = this.alive.map((p) => p.color.name).join(", ");
        const body = this.transcript() || "(nobody has spoken yet)";
        const situation = fresh === 0
          ? "Nobody has spoken since you last checked."
          : `${fresh} new message(s) since you last checked.`;
        const duty = spoken === 0
          ? "You have not spoken at all this round. You must reply with a message, not PASS."
          : `You have sent ${spoken} message(s) this round.`;
        const prompt = `You are ${bot.color.name}. Day ${this.day}. Players alive: ${roster}.\n` +
          `${situation} ${duty}\n\n` +
          `Chat so far:\n${body}\n\nPASS or your message:`;
        const text = await generate(bot.modelId ?? "", CHAT_SYSTEM, prompt, 120);
        if (this.phase !== "day" || !bot.alive) return;
        const clean = text.replace(/^["']+|["']+$/g, "").trim();
        if (!clean) continue;
        if (/^pass\b/i.test(clean) || /^pass$/i.test(clean)) continue;
        spoken += 1;
        this.aiMessageCount += 1;
        this.say("chat", clean.slice(0, 300), bot);
        seen = this.chatCount();
      }
    })();
  }

  private async votePhase() {
    this.votes.clear();
    this.lastVoteAt.clear();
    this.setPhase("vote", VOTE_MS);
    this.say("system", "Voting is open. Choose who to eject, or skip.");
    for (const bot of this.aliveAIs) this.aiVote(bot);
    await sleep(VOTE_MS);
    await this.resolveVote();
  }

  private aiVote(bot: Player) {
    (async () => {
      await sleep(2000 + Math.random() * (VOTE_MS - 6000));
      if (this.phase !== "vote" || !bot.alive) return;
      const options = this.alive.filter((p) => p.id !== bot.id).map((p) => p.color.name);
      const allies = this.aliveAIs.filter((p) => p.id !== bot.id).map((p) => p.color.name);
      const prompt = `You are ${bot.color.name}. Your fellow AI players are: ` +
        `${allies.join(", ") || "none"}.\nNever vote for a fellow AI.\n` +
        `Options: ${options.join(", ")}, SKIP\n\nChat:\n${this.transcript()}\n\nYour vote:`;
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
    const aiSeats = this.list.filter((p) => p.isAI).length;
    recordGame(this.modelId, {
      aiWon: winner === "ai",
      aiSeats,
      aiEjected: this.aiEjectedCount,
      messagesSent: this.aiMessageCount,
    }).catch((e) => console.error("[stats]", e));
    setTimeout(() => this.resetToLobby(), RESET_MS);
    return true;
  }

  resetToLobby() {
    for (const p of this.list) {
      if (p.isAI) this.players.delete(p.id);
      else if (!p.connected) this.players.delete(p.id);
      else p.alive = true;
    }
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
