import {
  listAvailableDates,
  loadDay,
  play,
  pause,
  seekTo,
  setSpeed,
  stopPlayback,
  getPlaybackState,
} from "./playback.js";
import { connect, disconnect } from "./ws.js";

let isPlaybackMode = false;

export function initPlaybackUI(): void {
  const historyBtn = document.getElementById("history-btn")!;
  const playbackEl = document.getElementById("playback")!;
  const closeBtn = document.getElementById("pb-close")!;
  const dateSelect = document.getElementById("pb-date")! as HTMLSelectElement;
  const playBtn = document.getElementById("pb-play")!;
  const slider = document.getElementById("pb-slider")! as HTMLInputElement;
  const timeLabel = document.getElementById("pb-time")!;
  const speedSelect = document.getElementById("pb-speed")! as HTMLSelectElement;

  // History button — switch to playback mode
  historyBtn.addEventListener("click", async () => {
    const dates = await listAvailableDates();
    if (dates.length === 0) {
      alert("No recordings available. Enable RECORDING_ENABLED on the server.");
      return;
    }

    // Populate date picker
    dateSelect.innerHTML = dates
      .map((d) => `<option value="${d}">${d}</option>`)
      .join("");
    dateSelect.value = dates[dates.length - 1]!; // Latest date

    await enterPlayback(dates[dates.length - 1]!);
  });

  // Close — back to live
  closeBtn.addEventListener("click", () => {
    exitPlayback();
  });

  // Date change
  dateSelect.addEventListener("change", async () => {
    await enterPlayback(dateSelect.value);
  });

  // Play/pause
  playBtn.addEventListener("click", () => {
    const state = getPlaybackState();
    if (state.playing) {
      pause();
      playBtn.textContent = "▶";
    } else {
      play();
      playBtn.textContent = "⏸";
    }
  });

  // Slider scrub
  slider.addEventListener("input", () => {
    const state = getPlaybackState();
    const t = parseFloat(slider.value) / 100;
    const ts = state.minTimestamp + t * (state.maxTimestamp - state.minTimestamp);
    seekTo(ts);
    updateTimeLabel();
  });

  // Speed
  speedSelect.addEventListener("change", () => {
    setSpeed(parseInt(speedSelect.value, 10));
  });

  // Update time label periodically
  setInterval(updateTimeLabel, 200);

  function updateTimeLabel(): void {
    const state = getPlaybackState();
    if (!state.active) return;

    // Update slider position
    const range = state.maxTimestamp - state.minTimestamp;
    if (range > 0) {
      slider.value = String(((state.currentTimestamp - state.minTimestamp) / range) * 100);
    }

    // Time of day in Melbourne
    const d = new Date(state.currentTimestamp * 1000);
    timeLabel.textContent = d.toLocaleTimeString("en-AU", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: "Australia/Melbourne",
    });

    // Update play button
    playBtn.textContent = state.playing ? "⏸" : "▶";
  }

  async function enterPlayback(date: string): Promise<void> {
    // Disconnect live WebSocket
    disconnect();
    isPlaybackMode = true;

    historyBtn.style.display = "none";
    playbackEl.style.display = "flex";

    const ok = await loadDay(date);
    if (!ok) {
      alert(`Failed to load recording for ${date}`);
      exitPlayback();
      return;
    }

    // Start at the beginning
    seekTo(getPlaybackState().minTimestamp);
  }

  function exitPlayback(): void {
    stopPlayback();
    isPlaybackMode = false;

    playbackEl.style.display = "none";
    historyBtn.style.display = "block";

    // Reconnect live WebSocket
    connect();
  }
}
