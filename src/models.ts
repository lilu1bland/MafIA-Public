export type ProviderId = "anthropic" | "openai" | "google" | "scripted";

export interface ModelEntry {
  id: string;
  label: string;
  provider: ProviderId;
  model: string;
}

export const MODELS: ModelEntry[] = [
  { id: "opus-5", label: "Claude Opus 5", provider: "anthropic", model: "claude-opus-5" },
  { id: "sonnet-5", label: "Claude Sonnet 5", provider: "anthropic", model: "claude-sonnet-5" },
  { id: "haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", model: "claude-haiku-4-5" },
  { id: "gpt-5", label: "GPT-5", provider: "openai", model: "gpt-5" },
  { id: "gemini-2-5-flash", label: "Gemini 2.5 Flash", provider: "google", model: "gemini-2.5-flash" },
  { id: "scripted", label: "Scripted Bot", provider: "scripted", model: "scripted" },
];

export function providerAvailable(p: ProviderId): boolean {
  switch (p) {
    case "anthropic":
      return !!Deno.env.get("ANTHROPIC_API_KEY");
    case "openai":
      return !!Deno.env.get("OPENAI_API_KEY");
    case "google":
      return !!Deno.env.get("GOOGLE_API_KEY");
    case "scripted":
      return true;
  }
}

export function availableModels(): ModelEntry[] {
  return MODELS.filter((m) => providerAvailable(m.provider));
}

export function getModel(id: string): ModelEntry {
  return MODELS.find((m) => m.id === id) ?? MODELS[MODELS.length - 1];
}

export function randomModel(): ModelEntry {
  const pool = availableModels().filter((m) => m.provider !== "scripted");
  const list = pool.length > 0 ? pool : availableModels();
  return list[Math.floor(Math.random() * list.length)];
}
