import { store } from "./store.js";
import { reconnect } from "./ws.js";
import type { ClientState, TransportMode } from "./types.js";

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
      const counts: Record<TransportMode, number> = { metro: 0, tram: 0, bus: 0, vline: 0 };
      for (const v of worldState.vehicles) {
        counts[v.mode]++;
      }

      const segments: string[] = [];
      if (counts.metro > 0) segments.push(`TRAIN ${counts.metro}`);
      if (counts.tram > 0) segments.push(`TRAM ${counts.tram}`);
      if (counts.bus > 0) segments.push(`BUS ${counts.bus}`);
      if (counts.vline > 0) segments.push(`VLINE ${counts.vline}`);

      let text = segments.join(" · ");
      if (lastTickAt > 0) {
        text += `  ·  ${timeAgo(lastTickAt)}`;
      }

      info.textContent = text;
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
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}
