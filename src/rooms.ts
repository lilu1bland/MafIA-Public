import { Room } from "./game.ts";
import type { LobbySummary } from "./types.ts";

const rooms = new Map<string, Room>();
const IDLE_MS = 5 * 60_000;

export function createRoom(isPublic: boolean, maxPlayers: number): Room {
  let code = "";
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  const room = new Room(code, isPublic, maxPlayers);
  rooms.set(code, room);
  return room;
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.trim());
}

export function publicLobbies(): LobbySummary[] {
  return [...rooms.values()]
    .filter((r) => r.isPublic && r.phase === "lobby" && r.connectedHumans.length > 0)
    .filter((r) => r.humans.length < r.maxPlayers)
    .sort((a, b) => b.humans.length - a.humans.length)
    .slice(0, 30)
    .map((r) => r.summary());
}

export function reapRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const live = room.connectedHumans.length > 0;
    if (live) {
      room.lastSeen = now;
      continue;
    }
    if (now - room.lastSeen > IDLE_MS) rooms.delete(code);
  }
}

export function roomCount(): number {
  return rooms.size;
}
