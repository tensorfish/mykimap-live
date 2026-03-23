import { store } from "./store.js";
import { reconnect } from "./ws.js";
import { isMuted, toggleMuted, sounds } from "./audio.js";
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
  const soundBtn = document.getElementById("sound-btn")!;

  btn.addEventListener("click", () => { sounds.select(); reconnect(); });

  // Sound toggle — update icon on click
  function updateSoundBtn() {
    soundBtn.textContent = isMuted() ? "🔇" : "🔊";
    soundBtn.classList.toggle("on", !isMuted());
  }
  updateSoundBtn();
  soundBtn.addEventListener("click", () => {
    toggleMuted();
    updateSoundBtn();
    // Play a sound after unmuting so user hears confirmation
    if (!isMuted()) sounds.select();
  });

  // Connection state sounds (only when status bar is visible = live mode)
  let prevClientState: ClientState = "LOADING";
  const statusEl = document.getElementById("status")!;
  store.subscribe(() => {
    const { clientState } = store.state;
    if (clientState !== prevClientState) {
      const inLiveMode = statusEl.style.display !== "none";
      if (inLiveMode) {
        if (clientState === "ACTIVE" && prevClientState !== "LOADING") {
          sounds.connect();
        } else if (clientState === "DISCONNECTED") {
          sounds.disconnect();
        } else if (clientState === "RECONNECTING") {
          sounds.reconnecting();
        }
      }
      prevClientState = clientState;
    }
  });

  function update() {
    const { clientState, worldState } = store.state;

    dot.style.backgroundColor = STATE_COLORS[clientState];
    label.textContent = STATE_LABELS[clientState];

    if (clientState === "ACTIVE" && worldState) {
      // Count per mode
      info.textContent = "";
    } else {
      info.textContent = "";
    }

    btn.style.display = clientState === "DISCONNECTED" ? "inline-block" : "none";
  }

  store.subscribe(update);
}
