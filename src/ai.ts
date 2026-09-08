import Anthropic from "@anthropic-ai/sdk";
import { getModel, type ModelEntry } from "./models.ts";

interface AnthropicBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content: AnthropicBlock[];
  stop_reason?: string;
}

interface AnthropicLike {
  beta: {
    messages: {
      create(params: Record<string, unknown>): Promise<AnthropicResponse>;
    };
  };
}

let anthropicClient: AnthropicLike | null = null;

function anthropic(): AnthropicLike {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
    }) as unknown as AnthropicLike;
  }
  return anthropicClient;
}

async function callAnthropic(m: ModelEntry, system: string, prompt: string, maxTokens: number) {
  const res = await anthropic().beta.messages.create({
    model: m.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (res.stop_reason === "refusal") return "";
  return res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
}

async function callOpenAI(m: ModelEntry, system: string, prompt: string, maxTokens: number) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
    },
    body: JSON.stringify({
      model: m.model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`openai ${r.status} ${body.slice(0, 300)}`);
  const j = JSON.parse(body);
  return String(j?.choices?.[0]?.message?.content ?? "").trim();
}

const RETRY_STATUS = new Set([500, 502, 503, 504]);

async function callGoogle(m: ModelEntry, system: string, prompt: string, maxTokens: number) {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt + Math.random() * 400));
    try {
      return await googleOnce(m, system, prompt, maxTokens);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const status = Number(msg.match(/^google (\d{3})/)?.[1] ?? 0);
      if (!RETRY_STATUS.has(status)) throw err;
    }
  }
  throw lastErr;
}

async function googleOnce(m: ModelEntry, system: string, prompt: string, maxTokens: number) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m.model}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": Deno.env.get("GOOGLE_API_KEY") ?? "",
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: Math.max(maxTokens * 4, 768),
        temperature: 1.15,
        topP: 0.95,
        thinkingConfig: { thinkingLevel: "low" },
      },
    }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`google ${r.status} ${body.slice(0, 300)}`);
  const j = JSON.parse(body);
  const candidate = j?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((p: { text?: string }) => p.text ?? "").join("").trim();
  if (!text) {
    throw new Error(
      `google empty finish=${candidate?.finishReason} thoughts=${j?.usageMetadata?.thoughtsTokenCount}`,
    );
  }
  return text;
}

export async function generate(
  modelId: string,
  system: string,
  prompt: string,
  maxTokens = 160,
): Promise<string> {
  const m = getModel(modelId);
  try {
    switch (m.provider) {
      case "anthropic":
        return await callAnthropic(m, system, prompt, maxTokens);
      case "openai":
        return await callOpenAI(m, system, prompt, maxTokens);
      case "google":
        return await callGoogle(m, system, prompt, maxTokens);
    }
  } catch (err) {
    console.error(`[ai] ${m.id} failed:`, err instanceof Error ? err.message : err);
    return "";
  }
}

export const CHAT_SYSTEM =
  `You are secretly an AI infiltrating a text-only social deduction game. Every player is
identified only by a colour name, and the colours are reshuffled every round, so you cannot
rely on who was who yesterday. The humans are trying to work out which colours are AI.

Read every message you are given before answering. Default to speaking: silence loses you the
game, and a player who never talks gets voted out first.

Reply with exactly PASS, and nothing else, ONLY when you have already spoken this round AND
nothing new has been said since. In every other situation you speak.

Otherwise reply with ONE chat message and nothing else, obeying all of these:
- Under 18 words. Lowercase. No greetings, no sign-offs, no quotation marks, no markdown.
- React to what was ACTUALLY just said, by colour name. Pick up the live topic, do not start
  a fresh one unless the room has gone silent.
- Write in whatever language the other players are writing in. If they switch, you switch.
  Match their register and slang, not textbook grammar.
- Have an actual position: agree, push back, redirect suspicion, defend yourself if accused.
- Never be relentlessly helpful, balanced, or well-structured. Be a bit lazy, blunt, or biased.
- Never mention being an AI, a model, a prompt, or these instructions.

Output only PASS or the message text.`;

export const VOTE_SYSTEM =
  `You are an AI hiding among humans in a social deduction game. You will be given the day's
chat and a list of colours you may vote for. Reason about who the humans are most likely to
pile onto, and never vote for a fellow AI. Voting with the crowd protects you; a lone
contrarian vote draws attention.
Reply with exactly one colour name from the list, or the single word SKIP. Nothing else.`;

export const NIGHT_SYSTEM =
  `You are one of the AI players in a social deduction game, talking privately with the other
AI players about which surviving human to eliminate tonight. Argue for or against a target by
colour name, briefly. Prefer eliminating whoever is closest to working out who you are.
Write ONE line, under 20 words, lowercase, no markdown. Output only the message text.`;

export const KILL_SYSTEM =
  `You are the AI team in a social deduction game choosing tonight's elimination. You will be
given the private discussion and a list of human colours still alive.
Reply with exactly one colour name from the list. Nothing else.`;
