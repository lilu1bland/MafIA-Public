import { load } from "@std/dotenv";
import { contentType } from "@std/media-types";
import { extname, fromFileUrl, join, normalize } from "@std/path";
import { createRoom, getRoom, publicLobbies, reapRooms, roomCount } from "./src/rooms.ts";
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

const sockets = new Set<WebSocket>();

function presencePayload() {
  return JSON.stringify({
    t: "presence",
    online: sockets.size,
    lobbies: publicLobbies(),
  });
}

function broadcastPresence() {
  const payload = presencePayload();
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
      } catch {
        sockets.delete(ws);
      }
    }
  }
}

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
    socket.send(JSON.stringify({ t: "joined", playerId: p.id, code: r.code, token: p.token }));
    r.pushState();
    r.sendHistory(p);
    broadcastPresence();
  };

  socket.onopen = () => {
    sockets.add(socket);
    socket.send(presencePayload());
    broadcastPresence();
  };

  socket.onmessage = (ev) => {
    let data: ClientMessage;
    try {
      data = JSON.parse(String(ev.data));
    } catch {
      return;
    }

    if (data.t === "resume") {
      if (room) return;
      const r = getRoom(String(data.code ?? ""));
      if (!r) return socket.send(JSON.stringify({ t: "resume_failed" }));
      const p = r.resume(String(data.token ?? ""), socket);
      if (!p) return socket.send(JSON.stringify({ t: "resume_failed" }));
      attach(r, p);
      return;
    }

    if (data.t === "create") {
      if (room) return;
      const cap = Number(data.maxPlayers ?? MAX_PLAYERS);
      const r = createRoom(Boolean(data.isPublic), Number.isFinite(cap) ? cap : MAX_PLAYERS);
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
      if (!p) return fail(`That lobby is full (${r.maxPlayers} players).`);
      attach(r, p);
      return;
    }

    if (!room || !me) return;
    room.lastSeen = Date.now();

    switch (data.t) {
      case "start":
        if (room.humans.length < MIN_PLAYERS) {
          return fail(`You need at least ${MIN_PLAYERS} players.`);
        }
        room.start(me.id);
        broadcastPresence();
        break;
      case "model":
        room.setModel(me.id, String(data.modelId ?? ""));
        break;
      case "visibility":
        room.setVisibility(me.id, Boolean(data.isPublic));
        broadcastPresence();
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
      case "leave":
        room.markDisconnected(me.id);
        room = null;
        me = null;
        broadcastPresence();
        break;
      case "ping":
        socket.send(JSON.stringify({ t: "pong" }));
        break;
    }
  };

  const drop = () => {
    sockets.delete(socket);
    if (room && me) room.markDisconnected(me.id);
    room = null;
    me = null;
    broadcastPresence();
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
    return json({ ok: true, rooms: roomCount(), online: sockets.size });
  }

  if (url.pathname === "/api/lobbies") {
    return json({ online: sockets.size, lobbies: publicLobbies() });
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
setInterval(broadcastPresence, 5_000);

console.log(`MafIA listening on http://localhost:${PORT}`);
