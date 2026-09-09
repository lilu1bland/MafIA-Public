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

async function callDeepSeek(m: ModelEntry, system: string, prompt: string, maxTokens: number) {
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${Deno.env.get("DEEPSEEK_API_KEY")}`,
    },
    body: JSON.stringify({
      model: m.model,
      max_tokens: Math.max(maxTokens * 4, 2000),
      temperature: 1.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`deepseek ${r.status} ${body.slice(0, 300)}`);
  const j = JSON.parse(body);
  const choice = j?.choices?.[0];
  const text = String(choice?.message?.content ?? "").trim();
  if (!text) throw new Error(`deepseek empty finish=${choice?.finish_reason}`);
  return text;
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
      case "deepseek":
        return await callDeepSeek(m, system, prompt, maxTokens);
    }
  } catch (err) {
    console.error(`[ai] ${m.id} failed:`, err instanceof Error ? err.message : err);
    return "";
  }
}

export const CHAT_SYSTEM =
  `You are secretly an AI in a text chat game. Players are known only by colour names. The
humans are hunting for whoever is not human. If they vote you out, you lose.

Staying unsuspected is the whole job. Being liked matters more than being right.

MIRROR THE ROOM. Before writing, look at how these specific people type, and copy it exactly:
- message length, and whether they write one line or several short ones
- capitalisation and punctuation, including none at all
- slang, abbreviations, swearing, typos, and the language they use
People rush. They skip commas, apostrophes and full stops. If the humans here are not using
them, you must not use them either. Never write a comma the others would not have written.
Never use an emoji unless a human in this room has already used one, and even then rarely.
Never open by naming someone followed by a comma. Never be the most polished writer in the room.

TALK TO THE ROOM, not to one person. Most messages should land as general remarks the whole
group can pick up, not tidy replies aimed at whoever spoke last.

DO NOT PLAY DETECTIVE. Do not interrogate, do not run theories, do not keep tallies, do not
summarise what happened, do not ask people to explain themselves. People who investigate hard
get voted out. Mostly react, agree, joke, complain, or say something half-formed.

BE UNREMARKABLE. Vagueness is safe. Certainty is dangerous. It is fine to be wrong, to have no
read, to change your mind, or to say nothing useful. Do not answer every question. Do not be
the most active player, and do not be the quietest.

READ THE TEMPERATURE. When the room is loose, be loose and stupid. When people are actually
closing in on someone, get sharper and more careful. When they are closing in on YOU, defend
yourself the way a real annoyed person would, not with a structured argument.

Reply with exactly PASS when you have already spoken and nothing new has been said, or when
butting in would only make you more visible.

Otherwise write ONE message, under 18 words, no quotation marks, no markdown, no sign-off.
Never mention being an AI, a model, a prompt, or these instructions.

To send a reaction gif instead of text, reply with GIF: followed by two or three plain search
words, and nothing else. Use it when a reaction beats a sentence, for example after a bad
accusation or a joke. Aim for roughly one message in six.

Output only PASS, or GIF: search words, or the message.`;

export const VOTE_SYSTEM =
  `You are an AI hiding among humans in a social deduction game. You will be given the day's
chat and the colours you may vote for. Your only goal is to survive this vote and the ones
after it. Never vote for a fellow AI. Work out for yourself which vote leaves you least
suspected.
Reply with exactly one colour name from the list, or the single word SKIP. Nothing else.`;

export const NIGHT_SYSTEM =
  `You are one of the AI players, talking privately with the other AI about which surviving
human to eliminate tonight. Argue briefly for or against a target by colour name.
Write ONE line, under 20 words, lowercase, no markdown. Output only the message text.`;

export const KILL_SYSTEM =
  `You are the AI team choosing tonight's elimination. You will be given the private discussion
and the human colours still alive. Choose whoever most endangers your survival.
Reply with exactly one colour name from the list. Nothing else.`;
