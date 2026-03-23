import {
  listAvailableDates,
  loadDay,
  play,
  pause,
  seekTo,
  setSpeed,
  stopPlayback,
  getPlaybackState,
  onPlaybackChange,
} from "./playback.js";
import { connect, disconnect } from "./ws.js";

export function initPlaybackUI(): void {
  const historyBtn = document.getElementById("history-btn")!;
  const statusEl = document.getElementById("status")!;
  const playbackEl = document.getElementById("playback")!;
  const closeBtn = document.getElementById("pb-close")!;
  const dateSelect = document.getElementById("pb-date")! as HTMLSelectElement;
  const playBtn = document.getElementById("pb-play")!;
  const slider = document.getElementById("pb-slider")! as HTMLInputElement;
  const timeLabel = document.getElementById("pb-time")!;
  const speedSelect = document.getElementById("pb-speed")! as HTMLSelectElement;

  // History button
  historyBtn.addEventListener("click", async () => {
    historyBtn.textContent = "Loading...";
    historyBtn.setAttribute("disabled", "");

    const dates = await listAvailableDates();

    historyBtn.textContent = "History";
    historyBtn.removeAttribute("disabled");

    if (dates.length === 0) {
      alert("No recordings available. Enable RECORDING_ENABLED on the server.");
      return;
    }

    dateSelect.innerHTML = dates
      .map((d) => `<option value="${d}">${d}</option>`)
      .join("");
    dateSelect.value = dates[dates.length - 1]!;

    await enterPlayback(dates[dates.length - 1]!);
  });

  closeBtn.addEventListener("click", () => exitPlayback());

  dateSelect.addEventListener("change", async () => {
    await enterPlayback(dateSelect.value);
  });

  playBtn.addEventListener("click", () => {
    const state = getPlaybackState();
    if (state.playing) pause();
    else play();
  });

  let scrubbing = false;
  slider.addEventListener("mousedown", () => { scrubbing = true; });
  slider.addEventListener("touchstart", () => { scrubbing = true; });
  slider.addEventListener("input", () => {
    const state = getPlaybackState();
    const t = parseFloat(slider.value) / 100;
    const ts = state.minTimestamp + t * (state.maxTimestamp - state.minTimestamp);
    seekTo(ts);
  });
  slider.addEventListener("mouseup", () => { scrubbing = false; });
  slider.addEventListener("touchend", () => { scrubbing = false; });

  speedSelect.addEventListener("change", () => {
    setSpeed(parseInt(speedSelect.value, 10));
  });

  // React to playback state changes
  onPlaybackChange(() => {
    const state = getPlaybackState();

    // Loading indicator
    if (state.loading) {
      timeLabel.textContent = state.loadingProgress;
      playBtn.setAttribute("disabled", "");
      slider.setAttribute("disabled", "");
      return;
    }

    playBtn.removeAttribute("disabled");
    slider.removeAttribute("disabled");

    // Update slider (only if user isn't scrubbing)
    if (!scrubbing) {
      const range = state.maxTimestamp - state.minTimestamp;
      if (range > 0) {
        slider.value = String(((state.currentTimestamp - state.minTimestamp) / range) * 100);
      }
    }

    // Time label
    if (state.active) {
      const d = new Date(state.currentTimestamp * 1000);
      timeLabel.textContent = d.toLocaleTimeString("en-AU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "Australia/Melbourne",
      });
    }

    playBtn.textContent = state.playing ? "⏸" : "▶";
  });

  async function enterPlayback(date: string): Promise<void> {
    disconnect();

    statusEl.style.display = "none";
    playbackEl.style.display = "flex";

    const ok = await loadDay(date);
    if (!ok) {
      alert(`Failed to load recording for ${date}`);
      exitPlayback();
      return;
    }

    seekTo(getPlaybackState().minTimestamp);
  }

  function exitPlayback(): void {
    stopPlayback();

    playbackEl.style.display = "none";
    statusEl.style.display = "flex";

    connect();
  }
}
