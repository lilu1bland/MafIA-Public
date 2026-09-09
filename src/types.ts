import type { GameColor } from "./colors.ts";

export type Phase = "lobby" | "day" | "vote" | "reveal" | "night" | "over";

export type Winner = "humans" | "ai" | null;

export interface Player {
  id: string;
  token: string;
  name: string;
  color: GameColor;
  isAI: boolean;
  alive: boolean;
  modelId: string | null;
  connected: boolean;
  socket: WebSocket | null;
}

export type ChatKind = "chat" | "gif" | "system" | "ai_private";

export interface ChatMessage {
  id: string;
  playerId: string | null;
  colorName: string | null;
  colorCss: string | null;
  kind: ChatKind;
  text: string;
  day: number;
  ts: number;
}

export interface ClientMessage {
  t: string;
  code?: string;
  name?: string;
  text?: string;
  url?: string;
  target?: string;
  modelId?: string;
  token?: string;
  isPublic?: boolean;
  maxPlayers?: number;
}

export interface PublicPlayer {
  id: string;
  colorName: string;
  colorCss: string;
  alive: boolean;
  connected: boolean;
  name?: string;
  isAI?: boolean;
  modelId?: string | null;
}

export interface LobbySummary {
  code: string;
  players: number;
  maxPlayers: number;
  modelLabel: string;
  hostName: string;
}
