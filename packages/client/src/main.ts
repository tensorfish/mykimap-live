import { initErrorModal } from "./error-modal.js";
import { initMap } from "./map.js";
import { initStatusBar } from "./ui.js";
import { initPanel } from "./panel.js";
import { initFilters } from "./filters.js";
import { initPlaybackUI } from "./playback-ui.js";
import { connect } from "./ws.js";
import { transition, selectVehicle, getSelectedEntityId } from "./store.js";
import { getPlaybackState, play, pause, seekTo } from "./playback.js";
import { sounds } from "./audio.js";

// Init error modal first so it catches everything
initErrorModal();

// ── Bootstrap ──

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string;

if (!MAPBOX_TOKEN) {
  transition("ERROR", "Missing VITE_MAPBOX_ACCESS_TOKEN env var");
  document.getElementById("status-label")!.textContent =
    "Error: Set VITE_MAPBOX_ACCESS_TOKEN in .env";
} else {
  const container = document.getElementById("map")! as HTMLDivElement;

  initStatusBar();
  initPanel();
  initFilters();
  initPlaybackUI();

  initMap(container, MAPBOX_TOKEN, () => {
    transition("CONNECTING", "Map loaded");
    connect();
  });

  // ── Legend (first visit) ──
  const legendEl = document.getElementById("legend")!;
  const legendSeen = localStorage.getItem("mykimap-legend-seen");
  if (legendSeen) {
    legendEl.remove();
  } else {
    document.getElementById("legend-dismiss")!.addEventListener("click", () => {
      sounds.select();
      legendEl.classList.add("hidden");
      localStorage.setItem("mykimap-legend-seen", "1");
      setTimeout(() => legendEl.remove(), 300);
    });
  }

  // ── Keyboard shortcuts ──
  document.addEventListener("keydown", (e) => {
    // Ignore when typing in an input
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

    const pb = getPlaybackState();

    switch (e.key) {
      case " ":
        e.preventDefault();
        if (pb.active) { pb.playing ? pause() : play(); }
        break;
      case "Escape":
        if (getSelectedEntityId()) { selectVehicle(null); }
        break;
      case "ArrowLeft":
        if (pb.active) { e.preventDefault(); seekTo(pb.currentTimestamp - 15); }
        break;
      case "ArrowRight":
        if (pb.active) { e.preventDefault(); seekTo(pb.currentTimestamp + 15); }
        break;
    }
  });
}
