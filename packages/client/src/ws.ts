import { transition, applyTick } from "./store.js";
import { showError } from "./error-modal.js";
import type { WorldState } from "./types.js";

const STALE_THRESHOLD_MS = 5_000;
const MAX_RETRIES = 5;
const RECONNECT_BASE_MS = 1_000;

let ws: WebSocket | null = null;
let retries = 0;
let staleTimer: ReturnType<typeof setTimeout> | null = null;

function clearStaleTimer(): void {
  if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
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
      const msg = JSON.parse(event.data as string);

      if (msg.type === "init") {
        // Initial backlog — emit event for the map to process
        window.dispatchEvent(new CustomEvent("vehicle-backlog", { detail: { backlog: msg.backlog } }));
        // Apply the last tick as current state
        const backlog = msg.backlog as WorldState[];
        if (backlog.length > 0) applyTick(backlog[backlog.length - 1]!);
      } else if (msg.type === "tick") {
        // Regular tick: append to path queue
        applyTick(msg as WorldState);
      }

      resetStaleTimer();
    } catch (error) {
      showError("WebSocket message parse failed", error);
    }
  };

  ws.onclose = () => {
    ws = null;
    clearStaleTimer();
    scheduleReconnect();
  };

  ws.onerror = () => {};
}

export function disconnect(): void {
  clearStaleTimer();
  retries = MAX_RETRIES; // prevent auto-reconnect
  if (ws) { ws.close(); ws = null; }
}

export function reconnect(): void {
  retries = 0;
  if (ws) { ws.close(); ws = null; }
  connect();
}
