import {
  listAvailableDates,
  loadMeta,
  loadInitialChunk,
  play,
  pause,
  seekTo,
  setSpeed,
  stopPlayback,
  getPlaybackState,
  onPlaybackChange,
  type PlaybackState,
} from "./playback.js";
import { connect, disconnect } from "./ws.js";
import { sounds } from "./audio.js";

export interface PlaybackUIControls {
  enterPlayback: (date: string, startTimestamp?: number) => Promise<void>;
}

export function initPlaybackUI(): PlaybackUIControls {
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
  const sliderTooltip = document.getElementById("pb-slider-tooltip")!;
  const speedSelect = document.getElementById("pb-speed")! as HTMLSelectElement;
  const bufferBarInner = document.getElementById("pb-buffer-bar-inner")!;
  const bufferingOverlay = document.getElementById("pb-buffering-overlay")!;
  const bufferingText = document.getElementById("pb-buffering-text")!;

  // Available dates cache
  let availableDates: Set<string> = new Set();

  // History button — opens playback mode
  historyBtn.addEventListener("click", async () => {
    sounds.select();
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

    dateSelect.min = dates[0]!;
    dateSelect.max = dates[dates.length - 1]!;
    dateSelect.value = dates[dates.length - 1]!;
    dateSelect.title = `${dates.length} recording${dates.length === 1 ? "" : "s"}: ${dates[0]} to ${dates[dates.length - 1]}`;

    await enterPlayback(dates[dates.length - 1]!);
  });

  closeBtn.addEventListener("click", () => { sounds.select(); exitPlayback(); });

  dateSelect.addEventListener("change", async () => {
    sounds.select();
    const selected = dateSelect.value;
    if (!availableDates.has(selected)) {
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

  playBtn.addEventListener("click", async () => {
    const state = getPlaybackState();
    if (!state.active) return; // not ready — enterPlayback still loading meta/DuckDB
    if (state.playing) {
      pause();
      sounds.pause();
    } else {
      // If we haven't loaded any data yet, load the initial chunk first
      if (state.bufferedRanges.length === 0) {
        const ok = await loadInitialChunk(state.currentTimestamp);
        if (!ok || !getPlaybackState().active) return; // load failed or playback was stopped
      }
      // Re-read state after possible async gap — playback may have been stopped
      const current = getPlaybackState();
      if (!current.active) return;
      // If playback reached the end, restart from the beginning
      if (current.currentTimestamp >= current.maxTimestamp) {
        seekTo(current.minTimestamp);
      }
      play();
      sounds.play();
    }
  });

  backBtn.addEventListener("click", () => {
    const state = getPlaybackState();
    if (!state.active) return;
    sounds.select();
    seekTo(state.currentTimestamp - 15);
  });

  fwdBtn.addEventListener("click", () => {
    const state = getPlaybackState();
    if (!state.active) return;
    sounds.select();
    seekTo(state.currentTimestamp + 15);
  });

  let scrubbing = false;
  slider.addEventListener("mousedown", () => { scrubbing = true; });
  slider.addEventListener("touchstart", () => { scrubbing = true; });
  slider.addEventListener("input", () => {
    const state = getPlaybackState();
    if (!state.active) return;
    const t = parseFloat(slider.value) / 100;
    const ts = state.minTimestamp + t * (state.maxTimestamp - state.minTimestamp);
    seekTo(ts);
  });
  slider.addEventListener("mouseup", () => { scrubbing = false; });
  slider.addEventListener("touchend", () => { scrubbing = false; });

  // Hover tooltip — shows time at the cursor position on the slider
  const sliderWrap = document.getElementById("pb-slider-wrap")!;
  sliderWrap.addEventListener("mousemove", (e) => {
    const state = getPlaybackState();
    if (!state.active || state.maxTimestamp <= state.minTimestamp) return;
    const rect = slider.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ts = state.minTimestamp + pct * (state.maxTimestamp - state.minTimestamp);
    const time = new Date(ts * 1000).toLocaleTimeString("en-AU", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      timeZone: "Australia/Melbourne",
    });
    sliderTooltip.textContent = time;
    sliderTooltip.style.left = `${pct * 100}%`;
  });

  speedSelect.addEventListener("change", () => {
    setSpeed(parseInt(speedSelect.value, 10));
    sounds.speedChange();
  });

  // React to playback state changes
  onPlaybackChange(() => {
    const state = getPlaybackState();

    // Buffering overlay — visible when waiting for chunk data
    if (state.buffering) {
      bufferingOverlay.classList.add("visible");
      bufferingText.textContent = state.loadingProgress || "Buffering...";
    } else {
      bufferingOverlay.classList.remove("visible");
    }

    // Update slider (only if user isn't scrubbing)
    if (!scrubbing) {
      const range = state.maxTimestamp - state.minTimestamp;
      if (range > 0) {
        slider.value = String(((state.currentTimestamp - state.minTimestamp) / range) * 100);
      }
    }

    // Buffer bar — show loaded ranges as segments on the slider
    updateBufferBar(state);

    // Time label + document title + shareable URL
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

      // Update URL to shareable replay link
      const hhmmss = d.toLocaleTimeString("en-AU", {
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        timeZone: "Australia/Melbourne",
      });
      const replayPath = `/replay/${state.date}/${hhmmss}`;
      if (window.location.pathname !== replayPath) {
        history.replaceState(null, "", replayPath);
      }
    }

    playBtn.textContent = state.playing ? "⏸" : "▶";
  });

  function updateBufferBar(state: PlaybackState): void {
    const range = state.maxTimestamp - state.minTimestamp;
    if (range <= 0 || state.bufferedRanges.length === 0) {
      bufferBarInner.innerHTML = "";
      return;
    }

    // Build segment elements for each loaded range
    let html = "";
    for (const br of state.bufferedRanges) {
      const left = Math.max(0, ((br.from - state.minTimestamp) / range) * 100);
      const right = Math.min(100, ((br.to - state.minTimestamp) / range) * 100);
      const width = right - left;
      if (width > 0) {
        html += `<div class="pb-buffer-segment" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></div>`;
      }
    }
    bufferBarInner.innerHTML = html;
  }

  async function enterPlayback(date: string, startTimestamp?: number): Promise<void> {
    // Stop any existing playback first
    stopPlayback();
    disconnect();

    statusEl.style.display = "none";
    playbackEl.style.display = "flex";
    document.getElementById("vehicle-count")?.classList.add("hidden");

    // Step 1: Fetch metadata — slider is interactive immediately
    const meta = await loadMeta(date);
    if (!meta) {
      exitPlayback();
      return;
    }

    // Update date picker to reflect the loaded date
    dateSelect.value = date;

    // Sync speed from the UI selector
    setSpeed(parseInt(speedSelect.value, 10));

    // Step 2: Load the chunk containing the start time
    const ts = startTimestamp
      ? Math.max(meta.minTimestamp, Math.min(startTimestamp, meta.maxTimestamp))
      : meta.minTimestamp;
    await loadInitialChunk(ts);
  }

  function exitPlayback(): void {
    stopPlayback();
    bufferingOverlay.classList.remove("visible");
    document.title = "Myki Map - Live Melbourne Transport";
    document.getElementById("vehicle-count")?.classList.remove("hidden");

    // Clean replay URL — go back to root without reload
    if (window.location.pathname !== "/") {
      history.replaceState(null, "", "/");
    }

    playbackEl.style.display = "none";
    statusEl.style.display = "flex";

    connect();
  }

  return { enterPlayback };
}
