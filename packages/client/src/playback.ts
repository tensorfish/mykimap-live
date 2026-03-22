import * as duckdb from "@duckdb/duckdb-wasm";
import duckdb_wasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdb_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { store, applyTick } from "./store.js";
import type { WorldState, VehiclePosition } from "./types.js";

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;

// ── Playback state ──

export interface PlaybackState {
  active: boolean;
  date: string;
  minTimestamp: number;
  maxTimestamp: number;
  currentTimestamp: number;
  speed: number; // 1, 10, 60, 360
  playing: boolean;
}

let playback: PlaybackState = {
  active: false,
  date: "",
  minTimestamp: 0,
  maxTimestamp: 0,
  currentTimestamp: 0,
  speed: 1,
  playing: false,
};

let animFrameId: number | null = null;
let lastFrameTime = 0;

export function getPlaybackState(): PlaybackState {
  return playback;
}

// ── Init DuckDB WASM (browser) ──

async function initDuckDB(): Promise<void> {
  if (db) return;

  const bundle = await duckdb.selectBundle({
    mvp: {
      mainModule: duckdb_wasm,
      mainWorker: duckdb_worker,
    },
  });

  const worker = new Worker(bundle.mainWorker!);
  const logger = new duckdb.VoidLogger();
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule);
}

// ── Load a day's recording ──

export async function loadDay(date: string): Promise<boolean> {
  try {
    await initDuckDB();

    // Fetch Parquet file from server
    const resp = await fetch(`/data/snapshots/${date}`);
    if (!resp.ok) return false;
    const buffer = await resp.arrayBuffer();

    // Register in DuckDB
    await db!.registerFileBuffer(`${date}.parquet`, new Uint8Array(buffer));

    // Create view
    if (conn) await conn.close();
    conn = await db!.connect();
    await conn.query(`CREATE OR REPLACE VIEW snapshots AS SELECT * FROM '${date}.parquet'`);

    // Get time range
    const result = await conn.query(`SELECT MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM snapshots`);
    const row = result.toArray()[0] as any;

    playback = {
      active: true,
      date,
      minTimestamp: Number(row.min_ts),
      maxTimestamp: Number(row.max_ts),
      currentTimestamp: Number(row.min_ts),
      speed: 1,
      playing: false,
    };

    return true;
  } catch (error) {
    console.error("[playback] Failed to load day:", error);
    return false;
  }
}

// ── Query vehicles at a timestamp ──

async function queryAtTimestamp(ts: number): Promise<VehiclePosition[]> {
  if (!conn) return [];

  try {
    // Find the closest snapshot timestamp
    const tsResult = await conn.query(
      `SELECT MAX(timestamp) as ts FROM snapshots WHERE timestamp <= ${Math.floor(ts)}`
    );
    const snapshotTs = Number((tsResult.toArray()[0] as any)?.ts ?? 0);
    if (!snapshotTs) return [];

    const result = await conn.query(
      `SELECT * FROM snapshots WHERE timestamp = ${snapshotTs}`
    );

    return result.toArray().map((row: any) => ({
      entityId: row.entity_id,
      mode: row.mode,
      tripId: "",
      routeId: row.route_id,
      startTime: "",
      startDate: "",
      vehicleId: row.vehicle_id,
      vehicleLabel: "",
      latitude: row.latitude,
      longitude: row.longitude,
      bearing: row.bearing,
      speed: row.speed,
      timestamp: row.timestamp,
      stale: Boolean(row.stale),
      shapeDistTraveled: row.shape_dist,
      prevShapeDistTraveled: row.shape_dist,
      shapeId: "",
      pathSegment: [],
    }));
  } catch {
    return [];
  }
}

// ── Playback controls ──

export function seekTo(timestamp: number): void {
  playback.currentTimestamp = Math.max(playback.minTimestamp, Math.min(timestamp, playback.maxTimestamp));
  if (!playback.playing) {
    // Manual scrub — query and render immediately
    queryAndRender();
  }
}

export function setSpeed(speed: number): void {
  playback.speed = speed;
}

export function play(): void {
  playback.playing = true;
  lastFrameTime = performance.now();
  if (!animFrameId) animFrameId = requestAnimationFrame(playbackFrame);
}

export function pause(): void {
  playback.playing = false;
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
}

export function stopPlayback(): void {
  playback.active = false;
  playback.playing = false;
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
}

export async function listAvailableDates(): Promise<string[]> {
  try {
    const resp = await fetch("/data/snapshots");
    if (!resp.ok) return [];
    return await resp.json();
  } catch {
    return [];
  }
}

// ── Internal ──

async function queryAndRender(): Promise<void> {
  const vehicles = await queryAtTimestamp(playback.currentTimestamp);
  if (vehicles.length === 0) return;

  const state: WorldState = {
    timestamp: Math.floor(playback.currentTimestamp),
    vehicles,
    trails: {},
    alerts: [],
    serverState: "RUNNING",
    seq: 0,
  };

  applyTick(state);
}

function playbackFrame(now: number): void {
  if (!playback.playing || !playback.active) return;

  const dtMs = now - lastFrameTime;
  lastFrameTime = now;

  // Advance playback time by speed × real time
  playback.currentTimestamp += (dtMs / 1000) * playback.speed;

  if (playback.currentTimestamp >= playback.maxTimestamp) {
    playback.currentTimestamp = playback.maxTimestamp;
    playback.playing = false;
    queryAndRender();
    return;
  }

  queryAndRender();
  animFrameId = requestAnimationFrame(playbackFrame);
}
