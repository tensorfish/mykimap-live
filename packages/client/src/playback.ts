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

    const grouped = new Map<number, VehiclePosition[]>();
    for (const row of rows) {
      const ts = Number((row as any).timestamp);
      if (!grouped.has(ts)) grouped.set(ts, []);
      grouped.get(ts)!.push({
        entityId: (row as any).entity_id,
        mode: (row as any).mode,
        tripId: "",
        routeId: (row as any).route_id,
        startTime: "",
        startDate: "",
        vehicleId: (row as any).vehicle_id,
        vehicleLabel: "",
        latitude: (row as any).latitude,
        longitude: (row as any).longitude,
        bearing: (row as any).bearing,
        speed: (row as any).speed,
        timestamp: ts,
        stale: Boolean((row as any).stale),
        shapeDistTraveled: (row as any).shape_dist,
        prevShapeDistTraveled: (row as any).shape_dist,
        shapeId: "",
        pathSegment: [],
      });
    }

    allSnapshots = [...grouped.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, vehicles]) => ({ timestamp, vehicles }));

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
    console.error("[playback] Failed:", error);
    playback.loading = false;
    playback.loadingProgress = "";
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

function renderAtCurrentTime(): void {
  const idx = findSnapshotIndex(playback.currentTimestamp);
  const snap = allSnapshots[idx];
  if (!snap) return;

  applyTick({
    timestamp: snap.timestamp,
    vehicles: snap.vehicles,
    trails: {},
    alerts: [],
    serverState: "RUNNING",
    seq: 0,
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
  if (!playback.playing || !playback.active) return;

  const dtMs = now - lastFrameTime;
  lastFrameTime = now;

  playback.currentTimestamp += (dtMs / 1000) * playback.speed;

  if (playback.currentTimestamp >= playback.maxTimestamp) {
    playback.currentTimestamp = playback.maxTimestamp;
    playback.playing = false;
    notify();
    renderAtCurrentTime();
    return;
  }

  renderAtCurrentTime();
  notify();
  animFrameId = requestAnimationFrame(playbackFrame);
}
