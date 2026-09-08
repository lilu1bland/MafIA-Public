import { getModel, MODELS } from "./models.ts";

export interface ModelStat {
  modelId: string;
  label: string;
  games: number;
  aiWins: number;
  humanWins: number;
  aiSeats: number;
  aiEjected: number;
  aiSurvived: number;
  messagesSent: number;
}

function blank(modelId: string): ModelStat {
  return {
    modelId,
    label: getModel(modelId).label,
    games: 0,
    aiWins: 0,
    humanWins: 0,
    aiSeats: 0,
    aiEjected: 0,
    aiSurvived: 0,
    messagesSent: 0,
  };
}

let kv: Deno.Kv | null = null;
const memory = new Map<string, ModelStat>();

export async function initStats() {
  try {
    kv = await Deno.openKv(Deno.env.get("KV_PATH") || undefined);
  } catch {
    kv = null;
    console.warn("[stats] Deno KV unavailable, using in-memory stats");
  }
}

async function read(modelId: string): Promise<ModelStat> {
  if (kv) {
    const e = await kv.get<ModelStat>(["stats", modelId]);
    return e.value ?? blank(modelId);
  }
  return memory.get(modelId) ?? blank(modelId);
}

async function write(s: ModelStat) {
  if (kv) await kv.set(["stats", s.modelId], s);
  else memory.set(s.modelId, s);
}

export async function recordGame(
  modelId: string,
  opts: { aiWon: boolean; aiSeats: number; aiEjected: number; messagesSent: number },
) {
  const s = await read(modelId);
  s.label = getModel(modelId).label;
  s.games += 1;
  if (opts.aiWon) s.aiWins += 1;
  else s.humanWins += 1;
  s.aiSeats += opts.aiSeats;
  s.aiEjected += opts.aiEjected;
  s.aiSurvived += opts.aiSeats - opts.aiEjected;
  s.messagesSent += opts.messagesSent;
  await write(s);
}

export async function leaderboard(): Promise<ModelStat[]> {
  const out: ModelStat[] = [];
  for (const m of MODELS) out.push(await read(m.id));
  return out
    .filter((s) => s.games > 0)
    .sort((a, b) => b.aiWins / b.games - a.aiWins / a.games);
}
