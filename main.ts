import { load } from "@std/dotenv";
import { contentType } from "@std/media-types";
import { extname, fromFileUrl, join, normalize } from "@std/path";
import { createRoom, getRoom, reapRooms, roomCount } from "./src/rooms.ts";
import { MAX_PLAYERS, MIN_PLAYERS } from "./src/game.ts";
import { availableModels } from "./src/models.ts";
import { initStats, leaderboard } from "./src/stats.ts";
import { searchGifs } from "./src/klipy.ts";
import type { ClientMessage, Player } from "./src/types.ts";
import type { Room } from "./src/game.ts";

try {
  await load({ export: true });
} catch {
  console.warn("[env] no .env file found, using process environment");
}

await initStats();

const PORT = Number(Deno.env.get("PORT") ?? 8000);
const PUBLIC_DIR = fromFileUrl(new URL("./public/", import.meta.url));

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : normalize(pathname).replace(/^[/\\]+/, "");
  if (rel.includes("..")) return new Response("Forbidden", { status: 403 });
  const file = join(PUBLIC_DIR, rel);
  try {
    const body = await Deno.readFile(file);
    return new Response(body, {
      headers: {
        "content-type": contentType(extname(file)) ?? "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function bindSocket(socket: WebSocket) {
  let room: Room | null = null;
  let me: Player | null = null;

  const fail = (msg: string) => socket.send(JSON.stringify({ t: "error", msg }));

  const attach = (r: Room, p: Player) => {
    room = r;
    me = p;
    socket.send(JSON.stringify({ t: "joined", playerId: p.id, code: r.code }));
    r.pushState();
    r.sendHistory(p);
  };

  socket.onmessage = (ev) => {
    let data: ClientMessage;
    try {
      data = JSON.parse(String(ev.data));
    } catch {
      return;
    }

    if (data.t === "create") {
      if (room) return;
      const r = createRoom();
      const p = r.addPlayer(String(data.name ?? "player"), socket);
      if (!p) return fail("Could not create lobby.");
      attach(r, p);
      return;
    }

    if (data.t === "join") {
      if (room) return;
      const r = getRoom(String(data.code ?? ""));
      if (!r) return fail("No lobby with that code.");
      if (r.phase !== "lobby") return fail("That match has already started.");
      const p = r.addPlayer(String(data.name ?? "player"), socket);
      if (!p) return fail(`That lobby is full (${MAX_PLAYERS} players).`);
      attach(r, p);
      return;
    }

    if (!room || !me) return;

    switch (data.t) {
      case "start":
        if (room.humans.length < MIN_PLAYERS) {
          return fail(`You need at least ${MIN_PLAYERS} players.`);
        }
        room.start(me.id);
        break;
      case "model":
        room.setModel(me.id, String(data.modelId ?? ""));
        break;
      case "chat":
        room.chat(me.id, String(data.text ?? ""));
        break;
      case "gif":
        room.gif(me.id, String(data.url ?? ""));
        break;
      case "vote":
        room.vote(me.id, String(data.target ?? "skip"));
        break;
      case "ping":
        socket.send(JSON.stringify({ t: "pong" }));
        break;
    }
  };

  const drop = () => {
    if (room && me) room.removePlayer(me.id);
    room = null;
    me = null;
  };

  socket.onclose = drop;
  socket.onerror = drop;
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/ws") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected websocket", { status: 400 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    bindSocket(socket);
    return response;
  }

  if (url.pathname === "/api/health") {
    return json({ ok: true, rooms: roomCount() });
  }

  if (url.pathname === "/api/models") {
    return json(availableModels().map((m) => ({ id: m.id, label: m.label })));
  }

  if (url.pathname === "/api/stats") {
    return json(await leaderboard());
  }

  if (url.pathname === "/api/gifs") {
    const q = url.searchParams.get("q") ?? "";
    const cid = url.searchParams.get("cid") ?? "anon";
    return json(await searchGifs(q, cid));
  }

  return await serveStatic(url.pathname);
});

setInterval(reapRooms, 60_000);

console.log(`MafIA listening on http://localhost:${PORT}`);
