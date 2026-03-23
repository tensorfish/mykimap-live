import { store } from "./store.js";
import { reconnect } from "./ws.js";
import type { ClientState } from "./types.js";

const STATE_LABELS: Record<ClientState, string> = {
  LOADING: "Loading map…",
  CONNECTING: "Connecting…",
  WAITING_FOR_DATA: "Waiting for data…",
  ACTIVE: "Live",
  STALE: "Stale — waiting for update",
  RECONNECTING: "Reconnecting…",
  DISCONNECTED: "Disconnected",
  ERROR: "Error",
};

const STATE_COLORS: Record<ClientState, string> = {
  LOADING: "#888",
  CONNECTING: "#f0ad4e",
  WAITING_FOR_DATA: "#f0ad4e",
  ACTIVE: "#5cb85c",
  STALE: "#f0ad4e",
  RECONNECTING: "#f0ad4e",
  DISCONNECTED: "#d9534f",
  ERROR: "#d9534f",
};

export function initStatusBar(): void {
  const dot = document.getElementById("status-dot")!;
  const label = document.getElementById("status-label")!;
  const info = document.getElementById("status-info")!;
  const btn = document.getElementById("reconnect-btn")! as HTMLButtonElement;

  btn.addEventListener("click", reconnect);

  // Update every 500ms so the "ago" text stays fresh
  let lastState = "";
  function update() {
    const { clientState, worldState, lastTickAt } = store.state;

    dot.style.backgroundColor = STATE_COLORS[clientState];
    label.textContent = STATE_LABELS[clientState];

    if (clientState === "ACTIVE" && worldState) {
      // Count per mode
      info.textContent = lastTickAt > 0 ? timeAgo(lastTickAt) : "";
    } else {
      info.textContent = "";
    }

    btn.style.display = clientState === "DISCONNECTED" ? "inline-block" : "none";
  }

  store.subscribe(update);
  setInterval(update, 500);
}

function timeAgo(timestampMs: number): string {
  const seconds = Math.floor((Date.now() - timestampMs) / 1000);
  if (seconds < 60) return `updated ${seconds} second${seconds !== 1 ? "s" : ""} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `updated ${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `updated ${hours} hour${hours !== 1 ? "s" : ""} ${remMin} minute${remMin !== 1 ? "s" : ""} ago`;
}
