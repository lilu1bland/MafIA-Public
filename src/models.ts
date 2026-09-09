export type ProviderId = "anthropic" | "openai" | "google" | "deepseek";

export interface ModelEntry {
  id: string;
  label: string;
  provider: ProviderId;
  model: string;
}

export const MODELS: ModelEntry[] = [
  { id: "deepseek-chat", label: "DeepSeek Chat", provider: "deepseek", model: "deepseek-chat" },
  {
    id: "deepseek-reasoner",
    label: "DeepSeek Reasoner",
    provider: "deepseek",
    model: "deepseek-reasoner",
  },
];

export function providerAvailable(p: ProviderId): boolean {
  switch (p) {
    case "anthropic":
      return !!Deno.env.get("ANTHROPIC_API_KEY");
    case "openai":
      return !!Deno.env.get("OPENAI_API_KEY");
    case "google":
      return !!Deno.env.get("GOOGLE_API_KEY");
    case "deepseek":
      return !!Deno.env.get("DEEPSEEK_API_KEY");
  }
}

export function availableModels(): ModelEntry[] {
  return MODELS.filter((m) => providerAvailable(m.provider));
}

export function getModel(id: string): ModelEntry {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export function randomModel(): ModelEntry {
  const list = availableModels();
  if (list.length === 0) return MODELS[0];
  return list[Math.floor(Math.random() * list.length)];
}
