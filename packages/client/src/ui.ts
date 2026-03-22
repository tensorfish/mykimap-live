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

/**
 * Bind the status bar DOM elements to the store.
 * No framework — just direct DOM updates on store changes.
 */
export function initStatusBar(): void {
  const dot = document.getElementById("status-dot")!;
  const label = document.getElementById("status-label")!;
  const info = document.getElementById("status-info")!;
  const btn = document.getElementById("reconnect-btn")! as HTMLButtonElement;

  btn.addEventListener("click", reconnect);

  store.subscribe(() => {
    const { clientState, worldState } = store.state;

    dot.style.backgroundColor = STATE_COLORS[clientState];
    label.textContent = STATE_LABELS[clientState];

    if (clientState === "ACTIVE" && worldState) {
      const parts = [`${worldState.vehicles.length} vehicles`];
      if (worldState.alerts.length > 0) {
        parts.push(`${worldState.alerts.length} alerts`);
      }
      if (worldState.serverState !== "RUNNING") {
        parts.push(`Server: ${worldState.serverState}`);
      }
      info.textContent = parts.join(" · ");
    } else {
      info.textContent = "";
    }

    btn.style.display = clientState === "DISCONNECTED" ? "inline-block" : "none";
  });
}
