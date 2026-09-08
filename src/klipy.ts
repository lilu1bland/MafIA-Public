export interface Gif {
  id: string;
  url: string;
  preview: string;
  width: number;
  height: number;
}

function pick(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function normalize(raw: unknown): Gif | null {
  const id = String(pick(raw, ["id"]) ?? pick(raw, ["slug"]) ?? crypto.randomUUID());
  const url = pick(raw, ["file", "md", "gif", "url"]) ??
    pick(raw, ["file", "hd", "gif", "url"]) ??
    pick(raw, ["url"]);
  const preview = pick(raw, ["file", "sm", "gif", "url"]) ?? url;
  if (typeof url !== "string") return null;
  return {
    id,
    url,
    preview: typeof preview === "string" ? preview : url,
    width: Number(pick(raw, ["file", "md", "gif", "width"]) ?? 200),
    height: Number(pick(raw, ["file", "md", "gif", "height"]) ?? 200),
  };
}

export async function searchGifs(query: string, customerId: string): Promise<Gif[]> {
  const key = Deno.env.get("KLIPY_API_KEY");
  if (!key) return [];
  const base = Deno.env.get("KLIPY_BASE") ?? "https://api.klipy.com/api/v1";
  const path = query.trim() ? "gifs/search" : "gifs/trending";
  const url = new URL(`${base}/${key}/${path}`);
  if (query.trim()) url.searchParams.set("q", query.trim());
  url.searchParams.set("customer_id", customerId);
  url.searchParams.set("per_page", "24");
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`klipy ${r.status}`);
    const j = await r.json();
    const items: unknown[] = j?.data?.data ?? j?.data ?? [];
    return items.map(normalize).filter((g): g is Gif => g !== null);
  } catch (err) {
    console.error("[klipy]", err instanceof Error ? err.message : err);
    return [];
  }
}
