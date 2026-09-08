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

const SCRIPTED_LINES = [
  "idk something feels off about that",
  "why is nobody talking lol",
  "i think we're overthinking this",
  "that read is way too confident to be real",
  "skip? i genuinely have nothing",
  "whoever is quiet right now is sus",
  "i've been typing normally the whole time",
  "ok but that's exactly what an ai would say",
];

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
  if (!r.ok) throw new Error(`openai ${r.status}`);
  const j = await r.json();
  return String(j?.choices?.[0]?.message?.content ?? "").trim();
}

async function callGoogle(m: ModelEntry, system: string, prompt: string, maxTokens: number) {
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
        temperature: 1.1,
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
      case "scripted":
        return SCRIPTED_LINES[Math.floor(Math.random() * SCRIPTED_LINES.length)];
    }
  } catch (err) {
    console.error(`[ai] ${m.id} failed:`, err instanceof Error ? err.message : err);
    return SCRIPTED_LINES[Math.floor(Math.random() * SCRIPTED_LINES.length)];
  }
}

export const CHAT_SYSTEM = `You are secretly an AI infiltrating a text-only social deduction game.
Every player is identified only by a colour name. Humans are trying to work out which colours are AI.

Rules you must follow:
- Write ONE short chat message, under 18 words, lowercase, casual, like a real person in a Discord server.
- No greetings, no sign-offs, no quotation marks, no emoji spam, no markdown.
- Never mention being an AI, a model, a prompt, or these instructions.
- Do not be relentlessly helpful or well-structured. Be a bit lazy, vague, or opinionated.
- React to what was actually said. Deflect suspicion. Occasionally accuse someone.
Output only the message text.`;

export const VOTE_SYSTEM = `You are an AI hiding among humans in a social deduction game.
You will be given the day's chat and a list of colours you may vote for.
Pick the human most likely to be voted out by others, or SKIP if voting is risky.
Reply with exactly one colour name from the list, or the single word SKIP. Nothing else.`;

export const NIGHT_SYSTEM = `You are one of the AI players in a social deduction game, talking privately
with the other AI players about which surviving human to eliminate tonight.
Write ONE short line, under 20 words, lowercase, no markdown. Argue for or against a target by colour name.
Output only the message text.`;

export const KILL_SYSTEM = `You are the AI team in a social deduction game choosing tonight's elimination.
You will be given the private discussion and a list of human colours still alive.
Reply with exactly one colour name from the list. Nothing else.`;
