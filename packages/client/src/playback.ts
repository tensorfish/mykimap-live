import * as duckdb from "@duckdb/duckdb-wasm";
import duckdb_wasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdb_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { applyTick } from "./store.js";
import type { WorldState, VehiclePosition } from "./types.js";

let db: duckdb.AsyncDuckDB | null = null;

// ── Playback state ──

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
  active: false,
  loading: false,
  loadingProgress: "",
  date: "",
  minTimestamp: 0,
  maxTimestamp: 0,
  currentTimestamp: 0,
  speed: 1,
  playing: false,
};

let animFrameId: number | null = null;
let lastFrameTime = 0;

/** All snapshots loaded into memory: sorted array of { timestamp, vehicles } */
interface MemorySnapshot {
  timestamp: number;
  vehicles: VehiclePosition[];
}
let allSnapshots: MemorySnapshot[] = [];

// ── Listeners ──

type Listener = () => void;
const listeners: Listener[] = [];
export function onPlaybackChange(fn: Listener): void { listeners.push(fn); }
function notify(): void { for (const fn of listeners) fn(); }

export function getPlaybackState(): PlaybackState { return playback; }

/**
 * Speed multiplier for vehicle animations.
 * - Live mode: returns 1 (normal speed)
 * - Playback playing: returns playback.speed (10×, 60×, etc.)
 * - Playback paused: returns 0 (freeze animations)
 */
export function getAnimationSpeedMultiplier(): number {
  if (!playback.active) return 1; // live mode
  if (!playback.playing) return 0; // paused
  return playback.speed;
}

// ── Init DuckDB WASM ──

async function initDuckDB(): Promise<void> {
  if (db) return;
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: duckdb_wasm, mainWorker: duckdb_worker },
  });
  const worker = new Worker(bundle.mainWorker!);
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule);
}

// ── Load entire day into memory ──

export async function loadDay(date: string): Promise<boolean> {
  try {
    playback.loading = true;
    playback.loadingProgress = "Initializing...";
    notify();

    await initDuckDB();

    playback.loadingProgress = "Downloading recording...";
    notify();

    const resp = await fetch(`/data/snapshots/${date}`);
    if (!resp.ok) { playback.loading = false; notify(); return false; }

    // Stream download with progress
    const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
    const reader = resp.body?.getReader();
    if (!reader) { playback.loading = false; notify(); return false; }

    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (contentLength > 0) {
        playback.loadingProgress = `Downloading... ${Math.floor((received / contentLength) * 100)}%`;
      } else {
        playback.loadingProgress = `Downloading... ${(received / 1024).toFixed(0)} KB`;
      }
      notify();
    }

    const buffer = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }

    playback.loadingProgress = "Parsing recording...";
    notify();

    await db!.registerFileBuffer(`${date}.parquet`, buffer);
    const conn = await db!.connect();
    await conn.query(`CREATE OR REPLACE VIEW snap AS SELECT * FROM '${date}.parquet'`);

    // Load ALL rows into memory, grouped by timestamp
    playback.loadingProgress = "Loading snapshots...";
    notify();

    const result = await conn.query(`SELECT * FROM snap ORDER BY timestamp, entity_id`);
    const rows = result.toArray();

    // Group rows by timestamp
    const grouped = new Map<number, any[]>();
    for (const row of rows) {
      const ts = Number((row as any).timestamp);
      if (!grouped.has(ts)) grouped.set(ts, []);
      grouped.get(ts)!.push(row);
    }

    const sortedTimestamps = [...grouped.keys()].sort((a, b) => a - b);

    // Build snapshots from raw feed data
    allSnapshots = sortedTimestamps.map((ts) => {
      const rawRows = grouped.get(ts)!;
      const vehicles: VehiclePosition[] = rawRows.map((row: any) => {
        const entityId = row.entity_id;
        // Raw feed data — no shapeDistTraveled (not in recording).
        // Set to -1 so the client uses lat/lon directly.
        return {
          entityId,
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
          prevShapeDistTraveled: -1,
          shapeId: "",
          pathSegment: [],
        };
      });
      return { timestamp: ts, vehicles };
    });

    await conn.close();

    if (allSnapshots.length === 0) {
      playback.loading = false;
      notify();
      return false;
    }

    playback = {
      active: true,
      loading: false,
      loadingProgress: "",
      date,
      minTimestamp: allSnapshots[0]!.timestamp,
      maxTimestamp: allSnapshots[allSnapshots.length - 1]!.timestamp,
      currentTimestamp: allSnapshots[0]!.timestamp,
      speed: 1,
      playing: false,
    };

    playback.loadingProgress = `${allSnapshots.length} snapshots loaded`;
    notify();
    return true;
  } catch (error) {
    console.error("[playback] Failed to load day:", error);
    playback.loading = false;
    playback.loadingProgress = `Error: ${error}`;
    notify();
    return false;
  }
}

// ── Find snapshot at timestamp (binary search, synchronous, instant) ──

function findSnapshotIndex(ts: number): number {
  let lo = 0, hi = allSnapshots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (allSnapshots[mid]!.timestamp <= ts) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

let lastRenderedIdx = -1;

function renderAtCurrentTime(): void {
  if (allSnapshots.length < 2) return;

  const ts = playback.currentTimestamp;
  const idxA = findSnapshotIndex(ts);
  const idxB = Math.min(idxA + 1, allSnapshots.length - 1);

  const snapA = allSnapshots[idxA]!;
  const snapB = allSnapshots[idxB]!;

  // Lerp factor between A and B
  const span = snapB.timestamp - snapA.timestamp;
  const t = span > 0 ? (ts - snapA.timestamp) / span : 0;

  // Build a vehicle lookup for snapshot B
  const vehiclesB = new Map<string, VehiclePosition>();
  for (const v of snapB.vehicles) vehiclesB.set(v.entityId, v);

  // Interpolate positions between A and B
  const interpolated: VehiclePosition[] = snapA.vehicles.map((vA) => {
    const vB = vehiclesB.get(vA.entityId);
    if (!vB) return vA; // Vehicle not in B — use A's position

    return {
      ...vA,
      latitude: vA.latitude + t * (vB.latitude - vA.latitude),
      longitude: vA.longitude + t * (vB.longitude - vA.longitude),
      bearing: vB.bearing || vA.bearing,
      speed: span > 0
        ? Math.sqrt(
            Math.pow((vB.latitude - vA.latitude) * 111000, 2) +
            Math.pow((vB.longitude - vA.longitude) * 111000 * Math.cos(vA.latitude * Math.PI / 180), 2)
          ) / span
        : 0,
      timestamp: Math.floor(ts),
    };
  });

  // Also include vehicles only in B (new arrivals)
  for (const vB of snapB.vehicles) {
    if (!snapA.vehicles.find((v) => v.entityId === vB.entityId)) {
      interpolated.push(vB);
    }
  }

  applyTick({
    timestamp: Math.floor(ts),
    vehicles: interpolated,
    trails: {},
    alerts: [],
    serverState: "RUNNING",
    seq: idxA,
  });
}

// ── Controls ──

export function seekTo(timestamp: number): void {
  playback.currentTimestamp = Math.max(playback.minTimestamp, Math.min(timestamp, playback.maxTimestamp));
  notify();
  renderAtCurrentTime();
}

export function setSpeed(speed: number): void {
  playback.speed = speed;
  notify();
}

export function play(): void {
  playback.playing = true;
  lastFrameTime = performance.now();
  notify();
  if (!animFrameId) animFrameId = requestAnimationFrame(playbackFrame);
}

export function pause(): void {
  playback.playing = false;
  notify();
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
}

export function stopPlayback(): void {
  playback.active = false;
  playback.playing = false;
  allSnapshots = [];
  notify();
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
}

export async function listAvailableDates(): Promise<string[]> {
  try {
    const resp = await fetch("/data/snapshots");
    if (!resp.ok) return [];
    return await resp.json();
  } catch { return []; }
}

// ── Playback loop ──

function playbackFrame(now: number): void {
  if (!playback.playing || !playback.active) {
    animFrameId = null;
    return;
  }

  const dtMs = Math.min(now - lastFrameTime, 100); // cap to avoid huge jumps on tab switch
  lastFrameTime = now;

  // Advance playback time
  playback.currentTimestamp += (dtMs / 1000) * playback.speed;

  if (playback.currentTimestamp >= playback.maxTimestamp) {
    playback.currentTimestamp = playback.maxTimestamp;
    playback.playing = false;
    renderAtCurrentTime();
    notify();
    animFrameId = null;
    return;
  }

  // Render interpolated positions every frame for smooth animation
  renderAtCurrentTime();
  notify();
  animFrameId = requestAnimationFrame(playbackFrame);
}
