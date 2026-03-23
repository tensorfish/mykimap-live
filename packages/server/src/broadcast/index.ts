import type { ServerWebSocket } from "bun";
import type { WorldState } from "../types.js";
import { log } from "../logger.js";

/** All connected WebSocket clients */
const clients = new Set<ServerWebSocket<unknown>>();

/** Per-IP connection count for rate limiting */
const ipConnections = new Map<string, number>();

/** Max WebSocket connections per IP */
const MAX_CONNECTIONS_PER_IP = 5;

function getIp(ws: ServerWebSocket<unknown>): string {
  return (ws.remoteAddress || "unknown");
}

export function addClient(ws: ServerWebSocket<unknown>): boolean {
  const ip = getIp(ws);
  const count = ipConnections.get(ip) ?? 0;

  if (count >= MAX_CONNECTIONS_PER_IP) {
    log("warn", `Rejected WebSocket from ${ip} — limit reached (${count}/${MAX_CONNECTIONS_PER_IP})`);
    return false;
  }

  clients.add(ws);
  ipConnections.set(ip, count + 1);
  log("info", `Client connected from ${ip} (${count + 1} from this IP, ${clients.size} total)`);
  return true;
}

export function removeClient(ws: ServerWebSocket<unknown>): void {
  clients.delete(ws);
  const ip = getIp(ws);
  const count = ipConnections.get(ip) ?? 1;
  if (count <= 1) ipConnections.delete(ip);
  else ipConnections.set(ip, count - 1);
  log("info", `Client disconnected (${clients.size} total)`);
}

export function clientCount(): number {
  return clients.size;
}

/**
 * Broadcast the world state to all connected clients.
 * Serializes once, sends the same string to all — O(1) JSON.stringify.
 */
export function broadcast(state: WorldState): void {
  if (clients.size === 0) return;

  const payload = JSON.stringify({ type: "tick", ...state });

  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      clients.delete(ws);
    }
  }
}

/** Close all clients with a reason (graceful shutdown). */
export function closeAllClients(code: number, reason: string): void {
  for (const ws of clients) {
    try { ws.close(code, reason); } catch {}
  }
  clients.clear();
  ipConnections.clear();
}
