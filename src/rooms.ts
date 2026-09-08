import { Room } from "./game.ts";

const rooms = new Map<string, Room>();

export function createRoom(): Room {
  let code = "";
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  const room = new Room(code);
  rooms.set(code, room);
  return room;
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.trim());
}

export function reapRooms() {
  for (const [code, room] of rooms) {
    const live = room.list.some((p) => !p.isAI && p.connected);
    if (!live) rooms.delete(code);
  }
}

export function roomCount(): number {
  return rooms.size;
}
