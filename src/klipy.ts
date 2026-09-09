export interface Gif {
  id: string;
  url: string;
  preview: string;
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
  const url = pick(raw, ["file", "md", "gif", "url"]) ??
    pick(raw, ["file", "hd", "gif", "url"]) ??
    pick(raw, ["url"]);
  if (typeof url !== "string") return null;
  const preview = pick(raw, ["file", "sm", "gif", "url"]);
  return {
    id: String(pick(raw, ["id"]) ?? pick(raw, ["slug"]) ?? crypto.randomUUID()),
    url,
    preview: typeof preview === "string" ? preview : url,
  };
}

export function gifsEnabled(): boolean {
  return !!Deno.env.get("KLIPY_API_KEY");
}

export async function searchGifs(query: string, customerId: string): Promise<Gif[]> {
  const key = Deno.env.get("KLIPY_API_KEY");
  if (!key) return [];
  const base = Deno.env.get("KLIPY_BASE") ?? "https://api.klipy.com/api/v1";
  const q = query.trim().slice(0, 60);
  const path = q ? "gifs/search" : "gifs/trending";
  const url = new URL(`${base}/${key}/${path}`);
  if (q) url.searchParams.set("q", q);
  url.searchParams.set("customer_id", customerId);
  url.searchParams.set("per_page", "24");
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`klipy ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const items: unknown[] = j?.data?.data ?? j?.data ?? [];
    return items.map(normalize).filter((g): g is Gif => g !== null);
  } catch (err) {
    console.error("[klipy]", err instanceof Error ? err.message : err);
    return [];
  }
}
