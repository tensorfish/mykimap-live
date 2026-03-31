/**
 * Playback engine — YouTube-style streaming.
 *
 * Instead of downloading an entire day's Parquet upfront, this fetches
 * metadata first (slider renders instantly), then loads 30-minute chunks
 * on demand with prefetch. The buffer bar shows loaded ranges.
 */

import { applyTick, setPlaybackActive, getHeatmapEnabled } from "./store.js";
import { clearAnimations, recordHeatmapOnly, clearHeatmapTracker } from "./layers.js";
import { showError } from "./error-modal.js";
import type { VehiclePosition } from "./types.js";
import {
  fetchMeta,
  ensureLoaded,
  prefetch,
  resetChunks,
  cancelFetches,
  getAbortSignal,
  getAllSnapshots,
  getVehicleTimelines,
  getBufferedRanges,
  getSnapshotMeta,
  findSnapshotIndex,
  isLoaded,

  setCurrentPlaybackTs,
  type SnapshotMeta,
  type BufferedRange,
} from "./playback-chunks.js";

// ── State ──

export interface PlaybackState {
  active: boolean;
  loading: boolean;
  loadingProgress: string;
  date: string;
  minTimestamp: number;
  maxTimestamp: number;
  currentTimestamp: number;
  speed: number;
  playing: boolean;
  /** Whether we're waiting for a chunk to load (inline buffering, not full-screen) */
  buffering: boolean;
  /** Loaded time ranges for the buffer bar */
  bufferedRanges: BufferedRange[];
}

let playback: PlaybackState = {
  active: false, loading: false, loadingProgress: "",
  date: "", minTimestamp: 0, maxTimestamp: 0,
  currentTimestamp: 0, speed: 1, playing: false,
  buffering: false, bufferedRanges: [],
};

let lastFedIdx = -1;

/**
 * Generation counter — incremented on every seek or date change.
 * Async operations (buffer, prefetch) capture the generation at start
 * and bail out if it changed by the time they complete.
 * This prevents stale completions from corrupting state.
 */
let seekGeneration = 0;

// ── Listeners ──

type Listener = () => void;
const listeners: Listener[] = [];
export function onPlaybackChange(fn: Listener): void { listeners.push(fn); }
function notify(): void { for (const fn of listeners) fn(); }

export function getPlaybackState(): PlaybackState { return playback; }

/**
 * Animation speed multiplier — used by the SINGLE render loop in map.ts.
 * Live mode: 1. Playback playing: playback.speed. Paused/buffering: 0.
 */
export function getAnimationSpeedMultiplier(): number {
  if (!playback.active) return 1;
  if (!playback.playing || playback.buffering) return 0;
  return playback.speed;
}

/**
 * Called every frame by the render loop in map.ts.
 * Advances the playback timestamp and feeds snapshots when crossed.
 */
export function advancePlayback(dtMs: number): void {
  if (!playback.active || !playback.playing || playback.buffering) return;

  const cappedDt = Math.min(dtMs, 100);
  playback.currentTimestamp += (cappedDt / 1000) * playback.speed;
  setCurrentPlaybackTs(playback.currentTimestamp);

  if (playback.currentTimestamp >= playback.maxTimestamp) {
    playback.currentTimestamp = playback.maxTimestamp;
    playback.playing = false;
    feedCurrentSnapshot();
    notify();
    return;
  }

  // Check if we're about to run out of loaded data
  checkPrefetch();

  // Check if we've outrun the buffer
  if (!isLoaded(playback.currentTimestamp)) {
    wasPlayingBeforeBuffer = true; // was playing (this is called from advancePlayback)
    playback.buffering = true;
    notify();
    // Trigger loading the needed chunk (capture generation to detect stale completions)
    const gen = seekGeneration;
    bufferAndResume(playback.currentTimestamp, gen);
    return;
  }

  feedCurrentSnapshot();

  // Throttle UI notifications to 10fps
  const now = performance.now();
  if (now - lastNotifyTime > 100) {
    playback.bufferedRanges = getBufferedRanges();
    notify();
    lastNotifyTime = now;
  }
}

let lastNotifyTime = 0;

/**
 * When playback outruns the buffer, load the needed chunk and resume.
 * `gen` is the seek generation at call time — if it changed by the time
 * the fetch completes, another seek happened and this result is stale.
 */
async function bufferAndResume(timestamp: number, gen: number): Promise<void> {
  const signal = getAbortSignal();
  const ok = await ensureLoaded(timestamp, (msg) => {
    if (seekGeneration !== gen) return; // stale — a new seek superseded us
    playback.loadingProgress = msg;
    notify();
  }, signal);

  // Stale completion — a newer seek or stop happened while we were loading
  if (seekGeneration !== gen) return;

  if (!ok || !playback.active) {
    playback.buffering = false;
    playback.loadingProgress = "";
    notify();
    return;
  }

  playback.buffering = false;
  playback.loadingProgress = "";
  playback.bufferedRanges = getBufferedRanges();
  lastFedIdx = -1; // force re-feed after new data loaded

  // Auto-resume playback after buffer completes
  if (wasPlayingBeforeBuffer) {
    playback.playing = true;
  }

  feedCurrentSnapshot();
  notify();
}

/**
 * Check if we should prefetch the next chunk.
 * Triggers at ~70% through the current chunk, adjusted for playback speed.
 */
let prefetchPromise: Promise<boolean> | null = null;

function checkPrefetch(): void {
  if (prefetchPromise) return; // already prefetching

  const signal = getAbortSignal();
  const result = prefetch(playback.currentTimestamp, signal);
  if (result) {
    prefetchPromise = result;
    result.then(() => {
      prefetchPromise = null;
      playback.bufferedRanges = getBufferedRanges();
      notify();
    }).catch(() => {
      prefetchPromise = null;
    });
  }
}

/**
 * Feed the current snapshot into the animation pipeline.
 * Uses per-vehicle timelines for smooth movement.
 */
function feedCurrentSnapshot(): void {
  const allSnaps = getAllSnapshots();
  if (allSnaps.length === 0) return;

  const idx = findSnapshotIndex(playback.currentTimestamp);
  if (idx === lastFedIdx) return;
  lastFedIdx = idx;

  const snap = allSnaps[idx]!;
  const ts = playback.currentTimestamp;
  const timelines = getVehicleTimelines();

  const vehicles: VehiclePosition[] = snap.vehicles.map((v) => {
    const tl = timelines.get(v.entityId);
    if (!tl || tl.waypoints.length === 0) return v;

    // Advance timeline index past current playback time
    while (tl.nextIdx < tl.waypoints.length - 1 && tl.waypoints[tl.nextIdx]!.ts <= ts) {
      tl.nextIdx++;
    }

    const wp = tl.waypoints[Math.min(tl.nextIdx, tl.waypoints.length - 1)]!;
    return {
      ...v,
      latitude: wp.lat,
      longitude: wp.lon,
    };
  });

  applyTick({
    timestamp: snap.timestamp,
    vehicles,
    alerts: [],
    congestion: [],
    serverState: "RUNNING",
    seq: idx,
  });
}

// ── Heatmap from historical data ──

const HEATMAP_WINDOW_S = 600;
let heatmapRebuildTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a deferred heatmap rebuild. This is expensive (~60K shape projections)
 * so we never run it synchronously in the seek path. Instead we defer it
 * by a short delay so the UI update (vehicle positions) happens first.
 * Skipped entirely when heatmap is disabled.
 */
function scheduleBuildHeatmap(ts: number): void {
  if (heatmapRebuildTimer) clearTimeout(heatmapRebuildTimer);
  if (!getHeatmapEnabled()) return;

  heatmapRebuildTimer = setTimeout(() => {
    heatmapRebuildTimer = null;
    buildHeatmapForTime(ts);
  }, 50);
}

function buildHeatmapForTime(ts: number): void {
  const allSnaps = getAllSnapshots();
  if (allSnaps.length === 0) return;

  const windowStart = ts - HEATMAP_WINDOW_S;
  const startIdx = findSnapshotIndex(windowStart);
  const endIdx = findSnapshotIndex(ts);

  clearHeatmapTracker();
  for (let i = startIdx; i <= endIdx; i++) {
    const snap = allSnaps[i]!;
    if (snap.timestamp < windowStart) continue;
    recordHeatmapOnly(snap.vehicles);
  }
  clearHeatmapTracker();
}

// ── Public API ──

/**
 * Load metadata for a date — makes the slider interactive immediately.
 * Returns the metadata or null if the date has no data.
 */
export async function loadMeta(date: string): Promise<SnapshotMeta | null> {
  seekGeneration++;
  // Reset chunks first (also aborts any existing controller and sets it to null),
  // then get a fresh abort signal. Don't call cancelFetches() before resetChunks()
  // — that creates a controller that resetChunks immediately aborts.
  resetChunks();
  const signal = getAbortSignal();

  try {
    const m = await fetchMeta(date, signal);
    if (!m) return null;

    playback = {
      active: true,
      loading: false,
      loadingProgress: "",
      date,
      minTimestamp: m.minTimestamp,
      maxTimestamp: m.maxTimestamp,
      currentTimestamp: m.minTimestamp,
      speed: playback.speed || 10,
      playing: false,
      buffering: false,
      bufferedRanges: [],
    };
    setPlaybackActive(true);
    notify();
    return m;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    showError("Failed to load recording metadata", error);
    return null;
  }
}

/**
 * Load the chunk containing `timestamp` and prepare for playback.
 * This is the "press play" moment — loads one chunk, not the whole day.
 */
export async function loadInitialChunk(timestamp?: number): Promise<boolean> {
  const ts = timestamp ?? playback.minTimestamp;
  playback.buffering = true;
  playback.loadingProgress = "Loading...";
  notify();

  const signal = getAbortSignal();
  const ok = await ensureLoaded(ts, (msg) => {
    playback.loadingProgress = msg;
    notify();
  }, signal);

  playback.buffering = false;
  playback.loadingProgress = "";
  playback.bufferedRanges = getBufferedRanges();

  if (ok) {
    playback.currentTimestamp = ts;
    lastFedIdx = -1;
    resetTimelineIndices(ts);
    feedCurrentSnapshot();
  }

  notify();
  return ok;
}

/** Whether playback was playing before a buffering pause (to auto-resume) */
let wasPlayingBeforeBuffer = false;

export function seekTo(timestamp: number): void {
  // Increment generation — invalidates any in-flight buffer/seek
  seekGeneration++;
  const gen = seekGeneration;

  playback.currentTimestamp = Math.max(
    playback.minTimestamp,
    Math.min(timestamp, playback.maxTimestamp)
  );
  setCurrentPlaybackTs(playback.currentTimestamp);

  // If no data has been loaded yet (play hasn't been pressed), just update
  // the position marker without attempting any downloads.
  const ranges = getBufferedRanges();
  if (ranges.length === 0) {
    notify();
    return;
  }

  lastFedIdx = -1;
  clearAnimations();

  if (!isLoaded(playback.currentTimestamp)) {
    // Remember if we were playing so we can resume after buffering
    if (!playback.buffering) {
      wasPlayingBeforeBuffer = playback.playing;
    }

    // Pause playback while buffering
    playback.buffering = true;
    playback.loadingProgress = "";
    notify();

    // Cancel previous in-flight fetches and get a fresh signal
    cancelFetches();
    const signal = getAbortSignal();

    ensureLoaded(playback.currentTimestamp, (msg) => {
      if (seekGeneration !== gen) return; // stale
      playback.loadingProgress = msg;
      notify();
    }, signal).then((ok) => {
      if (seekGeneration !== gen) return; // stale — a newer seek superseded this one

      playback.buffering = false;
      playback.loadingProgress = "";
      playback.bufferedRanges = getBufferedRanges();
      if (ok) {
        lastFedIdx = -1;
        resetTimelineIndices(playback.currentTimestamp);
        feedCurrentSnapshot();
        scheduleBuildHeatmap(playback.currentTimestamp);

        // Auto-resume if playback was running before the buffer pause
        if (wasPlayingBeforeBuffer) {
          playback.playing = true;
        }
      }
      notify();
    });
    return;
  }

  // Data is already loaded — instant seek
  playback.buffering = false;
  playback.loadingProgress = "";
  resetTimelineIndices(playback.currentTimestamp);
  feedCurrentSnapshot();
  scheduleBuildHeatmap(playback.currentTimestamp);
  notify();
}

function resetTimelineIndices(ts: number): void {
  const timelines = getVehicleTimelines();
  for (const tl of timelines.values()) {
    // Binary search for the first waypoint with ts > target
    const wps = tl.waypoints;
    let lo = 0, hi = wps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (wps[mid]!.ts <= ts) lo = mid + 1;
      else hi = mid;
    }
    tl.nextIdx = lo;
  }
}

export function setSpeed(speed: number): void {
  playback.speed = speed;
  notify();
}

export function play(): void {
  playback.playing = true;
  // If current position is not loaded, trigger buffer
  if (!isLoaded(playback.currentTimestamp)) {
    playback.buffering = true;
    bufferAndResume(playback.currentTimestamp, seekGeneration);
  }
  notify();
}

export function pause(): void {
  playback.playing = false;
  notify();
}

export function stopPlayback(): void {
  seekGeneration++;
  cancelFetches();
  playback.active = false;
  playback.playing = false;
  playback.loading = false;
  playback.buffering = false;
  setPlaybackActive(false);
  resetChunks();
  lastFedIdx = -1;
  prefetchPromise = null;
  clearAnimations();
  notify();
}

export async function listAvailableDates(): Promise<string[]> {
  try {
    const resp = await fetch("/data/snapshots");
    if (!resp.ok) return [];
    return await resp.json();
  } catch (error) {
    showError("Failed to list recordings", error);
    return [];
  }
}
