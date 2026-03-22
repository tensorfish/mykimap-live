import type { ServerWebSocket } from "bun";
import type { WorldState } from "../types.js";
import { log } from "../logger.js";

/** All connected WebSocket clients */
const clients = new Set<ServerWebSocket<unknown>>();

export function addClient(ws: ServerWebSocket<unknown>): void {
  clients.add(ws);
  log("info", `Client connected (total: ${clients.size})`);
}

export function removeClient(ws: ServerWebSocket<unknown>): void {
  clients.delete(ws);
  log("info", `Client disconnected (total: ${clients.size})`);
}

export function clientCount(): number {
  return clients.size;
}

/**
 * Broadcast the world state to all connected clients.
 * Uses JSON serialization — with ~2000 vehicles at ~100 bytes each,
 * the payload is ~200KB which is fine for WebSocket.
 */
export function broadcast(state: WorldState): void {
  if (clients.size === 0) return;

  const payload = JSON.stringify(state);

  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      // Client probably disconnected — will be cleaned up on close event
      clients.delete(ws);
    }
  }
}
