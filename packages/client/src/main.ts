import { initErrorModal } from "./error-modal.js";
import { initMap } from "./map.js";
import { initStatusBar } from "./ui.js";
import { initPanel } from "./panel.js";
import { initFilters } from "./filters.js";
import { initPlaybackUI, type PlaybackUIControls } from "./playback-ui.js";
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
  const playbackUI = initPlaybackUI();

  initMap(container, MAPBOX_TOKEN, () => {
    transition("CONNECTING", "Map loaded");

    // Check for /replay/:date/:time URL — auto-enter playback
    const replayMatch = window.location.pathname.match(
      /^\/replay\/(\d{4}-\d{2}-\d{2})(?:\/(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
    );
    if (replayMatch) {
      const date = replayMatch[1]!;
      let startTs: number | undefined;
      if (replayMatch[2] && replayMatch[3]) {
        // Convert HH:MM:SS Melbourne time to POSIX timestamp.
        // Use Intl to resolve the correct UTC offset for that date
        // (handles AEST +10 vs AEDT +11 automatically).
        const hour = parseInt(replayMatch[2], 10);
        const minute = parseInt(replayMatch[3], 10);
        const second = replayMatch[4] ? parseInt(replayMatch[4], 10) : 0;
        const utcGuess = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`);
        const melbHour = parseInt(utcGuess.toLocaleString("en-AU", { hour: "numeric", hour12: false, timeZone: "Australia/Melbourne" }), 10);
        const offsetH = melbHour - utcGuess.getUTCHours();
        utcGuess.setHours(utcGuess.getUTCHours() - offsetH + hour);
        utcGuess.setMinutes(minute);
        utcGuess.setSeconds(second);
        startTs = Math.floor(utcGuess.getTime() / 1000);
      }
      playbackUI.enterPlayback(date, startTs).then(() => {
        play();
      });
    } else {
      connect();
    }
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
