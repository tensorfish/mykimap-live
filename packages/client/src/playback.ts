import * as duckdb from "@duckdb/duckdb-wasm";
import duckdb_wasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdb_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { applyTick } from "./store.js";
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

/** Feed the snapshot at currentTimestamp into the live system (if it changed) */
function feedCurrentSnapshot(): void {
  if (allSnapshots.length === 0) return;
  const idx = findSnapshotIndex(playback.currentTimestamp);
  if (idx === lastFedIdx) return;
  lastFedIdx = idx;

  const snap = allSnapshots[idx]!;
  applyTick({
    timestamp: snap.timestamp,
    vehicles: snap.vehicles,
    alerts: [],
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
  try {
    playback.loading = true;
    playback.loadingProgress = "Initializing...";
    notify();

    await initDuckDB();

    playback.loadingProgress = "Downloading recording...";
    notify();

    const resp = await fetch(`/data/snapshots/${date}`);
    if (!resp.ok) { playback.loading = false; notify(); return false; }

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
      playback.loadingProgress = contentLength > 0
        ? `Downloading... ${Math.floor((received / contentLength) * 100)}%`
        : `Downloading... ${(received / 1024).toFixed(0)} KB`;
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

    playback.loadingProgress = "Loading snapshots...";
    notify();

    const result = await conn.query(`SELECT * FROM snap ORDER BY timestamp, entity_id`);
    const rows = result.toArray();

    const grouped = new Map<number, any[]>();
    for (const row of rows) {
      const ts = Number((row as any).timestamp);
      if (!grouped.has(ts)) grouped.set(ts, []);
      grouped.get(ts)!.push(row);
    }

    const sortedTimestamps = [...grouped.keys()].sort((a, b) => a - b);
    const prevDists = new Map<string, { lat: number; lon: number }>();

    allSnapshots = sortedTimestamps.map((ts) => {
      const rawRows = grouped.get(ts)!;
      const vehicles: VehiclePosition[] = rawRows.map((row: any) => {
        const entityId = row.entity_id;
        const lat = row.latitude;
        const lon = row.longitude;
        const prev = prevDists.get(entityId);
        prevDists.set(entityId, { lat, lon });

        return {
          entityId,
          mode: row.mode,
          tripId: row.trip_id ?? "",
          routeId: row.route_id,
          startTime: row.start_time ?? "",
          startDate: row.start_date ?? "",
          vehicleId: row.vehicle_id,
          vehicleLabel: row.vehicle_label ?? "",
          latitude: lat,
          longitude: lon,
          bearing: row.bearing,
          speed: row.speed,
          timestamp: Number(row.vehicle_ts ?? ts),
          stale: false,
          shapeDistTraveled: -1,
          shapeId: "",
        };
      });
      return { timestamp: ts, vehicles };
    });

    await conn.close();
    lastFedIdx = -1;

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

// ── Controls ──

export function seekTo(timestamp: number): void {
  playback.currentTimestamp = Math.max(playback.minTimestamp, Math.min(timestamp, playback.maxTimestamp));
  lastFedIdx = -1;
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
  playback.active = false;
  playback.playing = false;
  allSnapshots = [];
  lastFedIdx = -1;
  notify();
}

export async function listAvailableDates(): Promise<string[]> {
  try {
    const resp = await fetch("/data/snapshots");
    if (!resp.ok) return [];
    return await resp.json();
  } catch { return []; }
}
