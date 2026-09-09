import { kvHandle } from "./stats.ts";
import { getModel } from "./models.ts";
import { generate, POSTMORTEM_SYSTEM } from "./ai.ts";

export const MISTAKES = [
  "talked_too_much",
  "answered_too_fast",
  "too_quiet",
  "defended_too_hard",
  "over_analytical",
  "voted_against_the_room",
  "style_mismatch",
  "too_agreeable",
  "other",
] as const;

export type Mistake = typeof MISTAKES[number];

const MAX_NOTES = 10;
const MAX_TACTICS = 10;
const MAX_NOTE_LEN = 110;
const LOBBY_MATCH_CAP = 50;
const INJECT_MISTAKES = 3;
const INJECT_NOTES = 2;
const INJECT_TACTICS = 2;

export interface MemoryRecord {
  scope: string;
  label: string;
  games: number;
  aiWins: number;
  mistakes: Record<string, number>;
  notes: string[];
  tactics: string[];
  updatedAt: number;
}

const fallback = new Map<string, MemoryRecord>();

function blank(scope: string, label: string): MemoryRecord {
  return {
    scope,
    label,
    games: 0,
    aiWins: 0,
    mistakes: {},
    notes: [],
    tactics: [],
    updatedAt: Date.now(),
  };
}

function key(scope: string): string[] {
  return ["memory", scope];
}

async function read(scope: string, label: string): Promise<MemoryRecord> {
  const kv = kvHandle();
  if (kv) {
    const e = await kv.get<MemoryRecord>(key(scope));
    return e.value ?? blank(scope, label);
  }
  return fallback.get(scope) ?? blank(scope, label);
}

async function write(rec: MemoryRecord) {
  const kv = kvHandle();
  if (kv) await kv.set(key(rec.scope), rec);
  else fallback.set(rec.scope, rec);
}

function trimList(list: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const t = item.trim().slice(0, MAX_NOTE_LEN);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(-max);
}

function compact(rec: MemoryRecord) {
  const ranked = Object.entries(rec.mistakes).sort((a, b) => b[1] - a[1]).slice(0, MISTAKES.length);
  rec.mistakes = Object.fromEntries(ranked);
  rec.notes = trimList(rec.notes, MAX_NOTES);
  rec.tactics = trimList(rec.tactics, MAX_TACTICS);
  if (rec.games > LOBBY_MATCH_CAP) {
    const half = Math.max(1, Math.floor(LOBBY_MATCH_CAP / 2));
    rec.games = half;
    rec.aiWins = Math.round((rec.aiWins / Math.max(1, rec.games)) * half);
    for (const k of Object.keys(rec.mistakes)) {
      const halved = Math.floor(rec.mistakes[k] / 2);
      if (halved > 0) rec.mistakes[k] = halved;
      else delete rec.mistakes[k];
    }
    rec.notes = rec.notes.slice(-Math.ceil(MAX_NOTES / 2));
    rec.tactics = rec.tactics.slice(-Math.ceil(MAX_TACTICS / 2));
  }
}

export async function memoryBlock(scope: string, label: string): Promise<string> {
  const rec = await read(scope, label);
  if (rec.games === 0) return "";
  const lines: string[] = [];
  const top = Object.entries(rec.mistakes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, INJECT_MISTAKES)
    .filter(([, n]) => n > 0);
  if (top.length > 0) {
    lines.push("How you have been caught before, most often first:");
    for (const [m, n] of top) lines.push(`- ${m.replace(/_/g, " ")} (${n})`);
  }
  const notes = rec.notes.slice(-INJECT_NOTES);
  if (notes.length > 0) {
    lines.push("Notes from rounds you lost:");
    for (const n of notes) lines.push(`- ${n}`);
  }
  const tactics = rec.tactics.slice(-INJECT_TACTICS);
  if (tactics.length > 0) {
    lines.push("What worked in rounds you won:");
    for (const t of tactics) lines.push(`- ${t}`);
  }
  if (lines.length === 0) return "";
  return lines.join("\n");
}

function parseVerdict(raw: string): { mistake: Mistake; note: string } {
  const line = raw.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
  const [rawCat, ...rest] = line.split("|");
  const cat = (rawCat ?? "").trim().toLowerCase().replace(/[^a-z_]/g, "");
  const mistake = (MISTAKES as readonly string[]).includes(cat) ? cat as Mistake : "other";
  const note = rest.join("|").trim().slice(0, MAX_NOTE_LEN);
  return { mistake, note };
}

export async function recordOutcome(opts: {
  scope: string;
  label: string;
  modelId: string;
  aiWon: boolean;
  transcript: string;
  aiColors: string;
}) {
  const rec = await read(opts.scope, opts.label);
  rec.games += 1;
  if (opts.aiWon) rec.aiWins += 1;

  const prompt = `The AI players were: ${opts.aiColors}.\nThe AI ${
    opts.aiWon ? "WON" : "LOST"
  } this match.\n\nTranscript:\n${opts.transcript}\n\nVerdict:`;
  const raw = await generate(opts.modelId, POSTMORTEM_SYSTEM, prompt, 120);

  if (raw) {
    const { mistake, note } = parseVerdict(raw);
    if (opts.aiWon) {
      if (note) rec.tactics.push(note);
    } else {
      rec.mistakes[mistake] = (rec.mistakes[mistake] ?? 0) + 1;
      if (note) rec.notes.push(note);
    }
  }

  rec.label = opts.label;
  rec.updatedAt = Date.now();
  compact(rec);
  await write(rec);
}

export async function allMemories(modelIds: string[]): Promise<MemoryRecord[]> {
  const out: MemoryRecord[] = [];
  for (const id of modelIds) {
    const rec = await read(id, getModel(id).label);
    if (rec.games > 0) out.push(rec);
  }
  return out.sort((a, b) => b.games - a.games);
}

export async function wipeMemory(scope: string) {
  const kv = kvHandle();
  if (kv) await kv.delete(key(scope));
  else fallback.delete(scope);
}
