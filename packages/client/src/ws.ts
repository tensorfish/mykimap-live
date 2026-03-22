import { store, transition, applyTick } from "./store.js";
import type { WorldState } from "./types.js";

const STALE_THRESHOLD_MS = 5_000;
const MAX_RETRIES = 5;
const RECONNECT_BASE_MS = 1_000;

let ws: WebSocket | null = null;
let retries = 0;
let staleTimer: ReturnType<typeof setTimeout> | null = null;

function clearStaleTimer(): void {
  if (staleTimer) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
}

function resetStaleTimer(): void {
  clearStaleTimer();
  staleTimer = setTimeout(() => {
    transition("STALE", "No tick received within threshold");
  }, STALE_THRESHOLD_MS);
}

function scheduleReconnect(): void {
  if (retries >= MAX_RETRIES) {
    transition("DISCONNECTED", "Max retries exhausted");
    return;
  }

  transition("RECONNECTING", "WebSocket closed");
  const delay = RECONNECT_BASE_MS * Math.pow(2, retries);
  retries++;
  setTimeout(connect, delay);
}

export function connect(): void {
  transition("CONNECTING", "WebSocket connect attempt");

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws`;

  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    retries = 0;
    transition("WAITING_FOR_DATA", "WebSocket connected");
  };

  ws.onmessage = (event) => {
    try {
      const data: WorldState = JSON.parse(event.data as string);
      applyTick(data);
      resetStaleTimer();
    } catch {
      console.error("[ws] Failed to parse message");
    }
  };

  ws.onclose = () => {
    ws = null;
    clearStaleTimer();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose fires after onerror — reconnection handled there
  };
}

/** Manual reconnect from the UI */
export function reconnect(): void {
  retries = 0;
  if (ws) {
    ws.close();
    ws = null;
  }
  connect();
}
