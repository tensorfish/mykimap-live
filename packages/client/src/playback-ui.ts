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
import { sounds } from "./audio.js";

export function initPlaybackUI(): void {
  const historyBtn = document.getElementById("history-btn")!;
  const statusEl = document.getElementById("status")!;
  const playbackEl = document.getElementById("playback")!;
  const closeBtn = document.getElementById("pb-close")!;
  const dateSelect = document.getElementById("pb-date")! as HTMLInputElement;
  const playBtn = document.getElementById("pb-play")!;
  const backBtn = document.getElementById("pb-back")!;
  const fwdBtn = document.getElementById("pb-fwd")!;
  const slider = document.getElementById("pb-slider")! as HTMLInputElement;
  const timeLabel = document.getElementById("pb-time")!;
  const markStart = document.getElementById("pb-mark-start")!;
  const markMid = document.getElementById("pb-mark-mid")!;
  const markEnd = document.getElementById("pb-mark-end")!;
  const speedSelect = document.getElementById("pb-speed")! as HTMLSelectElement;
  const loadingOverlay = document.getElementById("loading-overlay")!;
  const loadingText = document.getElementById("loading-text")!;
  const loadingCancel = document.getElementById("loading-cancel")!;
  const loadingBar = document.getElementById("loading-bar")!;

  loadingCancel.addEventListener("click", () => {
    stopPlayback();
    loadingOverlay.classList.remove("visible");
    exitPlayback();
  });

  // Available dates cache
  let availableDates: Set<string> = new Set();

  // History button
  historyBtn.addEventListener("click", async () => {
    historyBtn.textContent = "Loading...";
    historyBtn.setAttribute("disabled", "");

    const dates = await listAvailableDates();

    historyBtn.textContent = "History";
    historyBtn.removeAttribute("disabled");

    if (dates.length === 0) {
      alert("No recordings available yet. The server exports snapshots every 5 minutes — please try again shortly.");
      return;
    }

    availableDates = new Set(dates);

    // Set date picker range and value
    dateSelect.min = dates[0]!;
    dateSelect.max = dates[dates.length - 1]!;
    dateSelect.value = dates[dates.length - 1]!;
    dateSelect.title = `${dates.length} recording${dates.length === 1 ? "" : "s"}: ${dates[0]} to ${dates[dates.length - 1]}`;

    await enterPlayback(dates[dates.length - 1]!);
  });

  closeBtn.addEventListener("click", () => exitPlayback());

  dateSelect.addEventListener("change", async () => {
    const selected = dateSelect.value;
    if (!availableDates.has(selected)) {
      // No snapshot for this date — snap to nearest available
      const sorted = [...availableDates].sort();
      const nearest = sorted.reduce((best, d) =>
        Math.abs(new Date(d).getTime() - new Date(selected).getTime()) <
        Math.abs(new Date(best).getTime() - new Date(selected).getTime()) ? d : best
      );
      dateSelect.value = nearest;
      dateSelect.title = `No recording for ${selected}. Loaded ${nearest}.`;
      await enterPlayback(nearest);
    } else {
      dateSelect.title = `${availableDates.size} recording${availableDates.size === 1 ? "" : "s"} available`;
      await enterPlayback(selected);
    }
  });

  playBtn.addEventListener("click", () => {
    const state = getPlaybackState();
    if (state.playing) { pause(); sounds.pause(); }
    else { play(); sounds.play(); }
  });

  backBtn.addEventListener("click", () => {
    const state = getPlaybackState();
    seekTo(state.currentTimestamp - 15);
  });

  fwdBtn.addEventListener("click", () => {
    const state = getPlaybackState();
    seekTo(state.currentTimestamp + 15);
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
    sounds.speedChange();
  });

  // React to playback state changes
  onPlaybackChange(() => {
    const state = getPlaybackState();

    // Loading overlay
    if (state.loading) {
      loadingOverlay.classList.add("visible");
      loadingText.textContent = state.loadingProgress;
      // Extract percentage from progress text (e.g. "Downloading... 45%")
      const pctMatch = state.loadingProgress.match(/(\d+)%/);
      loadingBar.style.width = pctMatch ? `${pctMatch[1]}%` : "0%";
      playBtn.setAttribute("disabled", "");
      slider.setAttribute("disabled", "");
      return;
    }

    loadingOverlay.classList.remove("visible");
    playBtn.removeAttribute("disabled");
    slider.removeAttribute("disabled");

    // Update slider (only if user isn't scrubbing)
    if (!scrubbing) {
      const range = state.maxTimestamp - state.minTimestamp;
      if (range > 0) {
        slider.value = String(((state.currentTimestamp - state.minTimestamp) / range) * 100);
      }
    }

    // Time label + document title
    if (state.active) {
      const d = new Date(state.currentTimestamp * 1000);
      const time = d.toLocaleTimeString("en-AU", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        timeZone: "Australia/Melbourne",
      });
      timeLabel.textContent = time;
      const dateLabel = d.toLocaleDateString("en-AU", {
        day: "numeric", month: "short",
        timeZone: "Australia/Melbourne",
      });
      document.title = `Myki Map - ${dateLabel} ${time}`;
    }

    playBtn.textContent = state.playing ? "⏸" : "▶";

    // Slider time markers
    if (state.active && state.maxTimestamp > state.minTimestamp) {
      const fmt = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-AU", {
        hour: "2-digit", minute: "2-digit", timeZone: "Australia/Melbourne",
      });
      markStart.textContent = fmt(state.minTimestamp);
      markMid.textContent = fmt((state.minTimestamp + state.maxTimestamp) / 2);
      markEnd.textContent = fmt(state.maxTimestamp);
    }
  });

  async function enterPlayback(date: string): Promise<void> {
    // Stop any existing playback first (clears animation state)
    stopPlayback();
    disconnect();

    statusEl.style.display = "none";
    playbackEl.style.display = "flex";
    document.getElementById("vehicle-count")?.classList.add("hidden");

    const ok = await loadDay(date);
    if (!ok) {
      exitPlayback();
      return;
    }

    // Sync speed from the UI selector (HTML default may differ from state default)
    setSpeed(parseInt(speedSelect.value, 10));
    seekTo(getPlaybackState().minTimestamp);
  }

  function exitPlayback(): void {
    stopPlayback();
    document.title = "Myki Map - Live Melbourne Transport";
    document.getElementById("vehicle-count")?.classList.remove("hidden");

    playbackEl.style.display = "none";
    statusEl.style.display = "flex";

    connect();
  }
}
