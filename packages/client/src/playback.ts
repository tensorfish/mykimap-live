import * as duckdb from "@duckdb/duckdb-wasm";
import duckdb_wasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdb_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { applyTick, setPlaybackActive } from "./store.js";
import { clearAnimations, recordHeatmapOnly, clearHeatmapTracker } from "./layers.js";
import { showError } from "./error-modal.js";
import type { WorldState, VehiclePosition } from "./types.js";

let db: duckdb.AsyncDuckDB | null = null;

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
}

let playback: PlaybackState = {
  active: false, loading: false, loadingProgress: "",
  date: "", minTimestamp: 0, maxTimestamp: 0,
  currentTimestamp: 0, speed: 1, playing: false,
};

interface MemorySnapshot {
  timestamp: number;
  vehicles: VehiclePosition[];
}

let allSnapshots: MemorySnapshot[] = [];
let lastFedIdx = -1;
let loadAbort: AbortController | null = null;

/**
 * Per-vehicle movement timeline: only the timestamps where
 * the vehicle's position actually changed. Built at load time.
 * During playback, we feed upcoming targets from this timeline
 * so the animation queue always has depth.
 */
interface VehicleTimeline {
  entityId: string;
  /** Positions where the vehicle actually moved: [timestamp, lat, lon] */
  waypoints: Array<{ ts: number; lat: number; lon: number }>;
  /** Index of the next waypoint to feed */
  nextIdx: number;
}

const vehicleTimelines = new Map<string, VehicleTimeline>();

/** How many future waypoints to queue ahead */
const LOOKAHEAD = 5;

// ── Listeners ──

type Listener = () => void;
const listeners: Listener[] = [];
export function onPlaybackChange(fn: Listener): void { listeners.push(fn); }
function notify(): void { for (const fn of listeners) fn(); }

export function getPlaybackState(): PlaybackState { return playback; }

/**
 * Animation speed multiplier — used by the SINGLE render loop in map.ts.
 * Live mode: 1. Playback playing: playback.speed. Paused: 0.
 */
export function getAnimationSpeedMultiplier(): number {
  if (!playback.active) return 1;
  if (!playback.playing) return 0;
  return playback.speed;
}

/**
 * Called every frame by the render loop in map.ts (via advancePlayback).
 * Advances the playback timestamp and feeds new snapshots into the
 * live animation system when crossed. No separate rAF loop.
 */
export function advancePlayback(dtMs: number): void {
  if (!playback.active || !playback.playing) return;

  const cappedDt = Math.min(dtMs, 100);
  playback.currentTimestamp += (cappedDt / 1000) * playback.speed;

  if (playback.currentTimestamp >= playback.maxTimestamp) {
    playback.currentTimestamp = playback.maxTimestamp;
    playback.playing = false;
    feedCurrentSnapshot();
    notify();
    return;
  }

  feedCurrentSnapshot();

  // Throttle UI notifications to 10fps (slider update doesn't need 60fps)
  const now = performance.now();
  if (now - lastNotifyTime > 100) {
    notify();
    lastNotifyTime = now;
  }
}

let lastNotifyTime = 0;

/**
 * Feed vehicles with their next timeline waypoints as targets.
 * Instead of feeding raw snapshots (which have duplicate positions
 * from the 30s cache), we look ahead in each vehicle's timeline
 * and feed the NEXT actual position change. This keeps the
 * animation queue full and the movement continuous.
 */
function feedCurrentSnapshot(): void {
  if (allSnapshots.length === 0) return;
  const idx = findSnapshotIndex(playback.currentTimestamp);
  if (idx === lastFedIdx) return;
  lastFedIdx = idx;

  const snap = allSnapshots[idx]!;
  const ts = playback.currentTimestamp;

  // For each vehicle, advance its timeline index and build a vehicle
  // with the NEXT waypoint position (where it should be heading).
  const vehicles: VehiclePosition[] = snap.vehicles.map((v) => {
    const tl = vehicleTimelines.get(v.entityId);
    if (!tl || tl.waypoints.length === 0) return v;

    // Advance timeline index past current playback time
    while (tl.nextIdx < tl.waypoints.length - 1 && tl.waypoints[tl.nextIdx]!.ts <= ts) {
      tl.nextIdx++;
    }

    // Use the current timeline waypoint as the vehicle position
    // This is the actual moved-to position, not a cache duplicate
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
    serverState: "RUNNING", seq: idx,
  });
}

// ── DuckDB init ──

async function initDuckDB(): Promise<void> {
  if (db) return;
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: duckdb_wasm, mainWorker: duckdb_worker },
  });
  const worker = new Worker(bundle.mainWorker!);
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule);
}

// ── Load day ──

export async function loadDay(date: string): Promise<boolean> {
  // Cancel any in-flight load
  if (loadAbort) loadAbort.abort();
  loadAbort = new AbortController();
  const signal = loadAbort.signal;

  try {
    playback.loading = true;
    playback.loadingProgress = "Initializing...";
    notify();

    await initDuckDB();
    if (signal.aborted) return false;

    playback.loadingProgress = "Downloading snapshot...";
    notify();

    const resp = await fetch(`/data/snapshots/${date}`, { signal });
    if (!resp.ok) { playback.loading = false; notify(); return false; }

    const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
    const reader = resp.body?.getReader();
    if (!reader) { playback.loading = false; notify(); return false; }

    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      if (signal.aborted) { reader.cancel(); return false; }
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      playback.loadingProgress = contentLength > 0
        ? `Downloading snapshot... ${Math.floor((received / contentLength) * 100)}%`
        : `Downloading snapshot... ${(received / 1024).toFixed(0)} KB`;
      notify();
    }

    const buffer = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }

    if (signal.aborted) return false;

    playback.loadingProgress = "Loading recording...";
    notify();

    await db!.registerFileBuffer(`${date}.parquet`, buffer);
    const conn = await db!.connect();

    // Get the time range and total row count without loading all data
    const metaResult = await conn.query(
      `SELECT MIN(timestamp) as t_min, MAX(timestamp) as t_max, COUNT(*) as total FROM '${date}.parquet'`
    );
    const meta = metaResult.toArray()[0] as any;
    const tMin = Number(meta.t_min);
    const tMax = Number(meta.t_max);
    const totalRows = Number(meta.total);

    if (totalRows === 0 || tMax <= tMin) {
      await conn.close();
      playback.loading = false;
      notify();
      return false;
    }

    // Read in time-based chunks to avoid OOM.
    // Each chunk covers ~10 minutes = ~20 snapshots × ~2000 vehicles = ~40k rows.
    const CHUNK_SECONDS = 600;
    const grouped = new Map<number, VehiclePosition[]>();
    let rowCount = 0;

    for (let chunkStart = tMin; chunkStart <= tMax; chunkStart += CHUNK_SECONDS) {
      if (signal.aborted) { await conn.close(); return false; }

      const chunkEnd = Math.min(chunkStart + CHUNK_SECONDS, tMax + 1);
      const chunkResult = await conn.query(
        `SELECT * FROM '${date}.parquet' WHERE timestamp >= ${chunkStart} AND timestamp < ${chunkEnd} ORDER BY timestamp`
      );

      for (const batch of chunkResult.batches) {
        for (let ri = 0; ri < batch.numRows; ri++) {
          const row = batch.get(ri) as any;
          const ts = Number(row.timestamp);

          const v: VehiclePosition = {
            entityId: row.entity_id,
            mode: row.mode,
            tripId: row.trip_id ?? "",
            routeId: row.route_id,
            startTime: row.start_time ?? "",
            startDate: row.start_date ?? "",
            vehicleId: row.vehicle_id,
            vehicleLabel: row.vehicle_label ?? "",
            latitude: row.latitude,
            longitude: row.longitude,
            bearing: row.bearing,
            speed: row.speed,
            timestamp: Number(row.vehicle_ts ?? ts),
            stale: false,
            shapeDistTraveled: -1,
            shapeId: "",
          };

          let arr = grouped.get(ts);
          if (!arr) { arr = []; grouped.set(ts, arr); }
          arr.push(v);
          rowCount++;
        }
      }

      const pct = totalRows > 0 ? Math.floor((rowCount / totalRows) * 100) : 0;
      playback.loadingProgress = `Reading data... ${pct}%`;
      notify();
      await new Promise((r) => setTimeout(r, 0));
    }

    await conn.close();

    // Build sorted snapshots
    const sortedTimestamps = [...grouped.keys()].sort((a, b) => a - b);
    allSnapshots = sortedTimestamps.map((ts) => ({
      timestamp: ts,
      vehicles: grouped.get(ts)!,
    }));

    // Free the grouped map — data now lives in allSnapshots
    grouped.clear();

    lastFedIdx = -1;

    // Build per-vehicle movement timelines
    playback.loadingProgress = "Preparing timelines...";
    notify();

    vehicleTimelines.clear();
    for (let si = 0; si < allSnapshots.length; si++) {
      const snap = allSnapshots[si]!;
      for (const v of snap.vehicles) {
        let tl = vehicleTimelines.get(v.entityId);
        if (!tl) {
          tl = { entityId: v.entityId, waypoints: [], nextIdx: 0 };
          vehicleTimelines.set(v.entityId, tl);
        }
        const last = tl.waypoints[tl.waypoints.length - 1];
        if (!last || Math.abs(v.latitude - last.lat) > 0.0001 || Math.abs(v.longitude - last.lon) > 0.0001) {
          tl.waypoints.push({ ts: snap.timestamp, lat: v.latitude, lon: v.longitude });
        }
      }

      if (si % 500 === 0) {
        playback.loadingProgress = `Preparing timelines... ${Math.floor((si / allSnapshots.length) * 100)}%`;
        notify();
        await new Promise((r) => setTimeout(r, 0));
        if (signal.aborted) return false;
      }
    }

    if (allSnapshots.length === 0) {
      playback.loading = false; notify(); return false;
    }

    playback = {
      active: true, loading: false, loadingProgress: "",
      date,
      minTimestamp: allSnapshots[0]!.timestamp,
      maxTimestamp: allSnapshots[allSnapshots.length - 1]!.timestamp,
      currentTimestamp: allSnapshots[0]!.timestamp,
      speed: 1, playing: false,
    };
    setPlaybackActive(true);

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
    const suffix = date === today ? " (updated every 5 min)" : "";
    playback.loadingProgress = `${allSnapshots.length} snapshots loaded${suffix}`;
    notify();
    return true;
  } catch (error) {
    // Don't show error modal if user cancelled
    if (error instanceof DOMException && error.name === "AbortError") {
      playback.loading = false;
      notify();
      return false;
    }
    showError("Failed to load recording", error);
    playback.loading = false;
    playback.loadingProgress = "";
    notify();
    return false;
  }
}

// ── Binary search ──

function findSnapshotIndex(ts: number): number {
  let lo = 0, hi = allSnapshots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (allSnapshots[mid]!.timestamp <= ts) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ── Heatmap from historical data ──

const HEATMAP_WINDOW_S = 600; // 10 minutes — must match layers.ts

/**
 * Replay snapshots in the 10-minute window before `ts` through feedTick
 * so the heatmap accumulates naturally via the existing shape-snapping
 * and speed calculation code.
 */
function buildHeatmapForTime(ts: number): void {
  if (allSnapshots.length === 0) return;

  const windowStart = ts - HEATMAP_WINDOW_S;
  const startIdx = findSnapshotIndex(windowStart);
  const endIdx = findSnapshotIndex(ts);

  // Use heatmap-only recorder — doesn't touch animation state
  clearHeatmapTracker();
  for (let i = startIdx; i <= endIdx; i++) {
    const snap = allSnapshots[i]!;
    if (snap.timestamp < windowStart) continue;
    recordHeatmapOnly(snap.vehicles);
  }
  clearHeatmapTracker();
}

// ── Controls ──

export function seekTo(timestamp: number): void {
  playback.currentTimestamp = Math.max(playback.minTimestamp, Math.min(timestamp, playback.maxTimestamp));
  lastFedIdx = -1;

  // Clear animation state so vehicles teleport to the new position
  // instead of slowly crawling from where they were.
  clearAnimations();

  // Replay 10-min window to rebuild heatmap at the seek position.
  // Must happen after clearAnimations (which wipes anim state) and
  // before feedCurrentSnapshot (which sets the current frame).
  buildHeatmapForTime(playback.currentTimestamp);

  // Reset all timeline indices to match the seek position
  for (const tl of vehicleTimelines.values()) {
    tl.nextIdx = 0;
    while (tl.nextIdx < tl.waypoints.length - 1 && tl.waypoints[tl.nextIdx]!.ts <= playback.currentTimestamp) {
      tl.nextIdx++;
    }
  }

  feedCurrentSnapshot();
  notify();
}

export function setSpeed(speed: number): void {
  playback.speed = speed;
  notify();
}

export function play(): void {
  playback.playing = true;
  notify();
}

export function pause(): void {
  playback.playing = false;
  notify();
}

export function stopPlayback(): void {
  // Abort any in-flight download/processing
  if (loadAbort) { loadAbort.abort(); loadAbort = null; }

  playback.active = false;
  playback.playing = false;
  playback.loading = false;
  setPlaybackActive(false);
  allSnapshots = [];
  vehicleTimelines.clear();
  lastFedIdx = -1;
  clearAnimations();
  notify();
}

export async function listAvailableDates(): Promise<string[]> {
  try {
    const resp = await fetch("/data/snapshots");
    if (!resp.ok) return [];
    return await resp.json();
  } catch (error) { showError("Failed to list recordings", error); return []; }
}
