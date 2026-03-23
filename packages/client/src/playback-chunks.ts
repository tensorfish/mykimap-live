/**
 * Chunk manager for streaming historical playback.
 *
 * Instead of loading an entire day's Parquet upfront, this module fetches
 * 30-minute chunks on demand — like a video player buffering ahead of the
 * playhead. It tracks which time ranges are loaded, handles prefetch,
 * and evicts old chunks to bound memory.
 */

import * as duckdb from "@duckdb/duckdb-wasm";
import duckdb_wasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdb_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import type { VehiclePosition } from "./types.js";

// ── Types ──

export interface SnapshotMeta {
  date: string;
  minTimestamp: number;
  maxTimestamp: number;
  snapshotCount: number;
  hours: number[];
}

export interface MemorySnapshot {
  timestamp: number;
  vehicles: VehiclePosition[];
}

export interface VehicleTimeline {
  entityId: string;
  waypoints: Array<{ ts: number; lat: number; lon: number }>;
  nextIdx: number;
}

interface LoadedChunk {
  from: number;
  to: number;
  /** Index range within allSnapshots that belongs to this chunk */
  snapshotStartIdx: number;
  snapshotEndIdx: number;
  loadedAt: number;
}

export interface BufferedRange {
  from: number;
  to: number;
}

type ProgressCallback = (message: string) => void;

// ── Constants ──

const CHUNK_DURATION_S = 30 * 60; // 30 minutes

/**
 * Max loaded chunks — adaptive based on device memory.
 * navigator.deviceMemory returns 0.25–8 (GB, capped for fingerprinting).
 * Each peak chunk is ~13 MB in Parquet but ~40–80 MB decoded in JS heap
 * (snapshot objects + timeline waypoints).
 *
 * Conservative estimates assuming playback isn't the only tab:
 *   < 2 GB  → 4 chunks  (~2 hours, ~200 MB heap)
 *   2–4 GB  → 8 chunks  (~4 hours, ~400 MB heap)
 *   4–8 GB  → 16 chunks (~8 hours, ~800 MB heap)
 *   ≥ 8 GB  → 48 chunks (full day — no eviction needed)
 */
function getMaxChunks(): number {
  const mem = (navigator as any).deviceMemory as number | undefined;
  if (!mem || mem < 2) return 4;
  if (mem < 4) return 8;
  if (mem < 8) return 16;
  return 48; // full day fits
}

// ── DuckDB singleton ──

let db: duckdb.AsyncDuckDB | null = null;
let fileCounter = 0;

async function initDuckDB(): Promise<void> {
  if (db) return;
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: duckdb_wasm, mainWorker: duckdb_worker },
  });
  const worker = new Worker(bundle.mainWorker!);
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule);
}

// ── Chunk Manager ──

let currentDate = "";
let meta: SnapshotMeta | null = null;
let allSnapshots: MemorySnapshot[] = [];
let loadedChunks: LoadedChunk[] = [];
let vehicleTimelines = new Map<string, VehicleTimeline>();
let abortController: AbortController | null = null;

// In-flight fetch tracking to avoid duplicate requests
let inFlightChunks = new Set<string>();

/** Compute the chunk boundaries (from/to) for a given timestamp */
function chunkBounds(ts: number): { from: number; to: number } {
  if (!meta) throw new Error("No metadata loaded");
  // Align to 30-minute boundaries relative to the day's start
  const offset = ts - meta.minTimestamp;
  const chunkIdx = Math.floor(offset / CHUNK_DURATION_S);
  const from = meta.minTimestamp + chunkIdx * CHUNK_DURATION_S;
  const to = Math.min(from + CHUNK_DURATION_S, meta.maxTimestamp + 1);
  return { from, to };
}

function chunkKey(from: number, to: number): string {
  return `${from}_${to}`;
}

// ── Public API ──

export function getSnapshotMeta(): SnapshotMeta | null {
  return meta;
}

export function getAllSnapshots(): MemorySnapshot[] {
  return allSnapshots;
}

export function getVehicleTimelines(): Map<string, VehicleTimeline> {
  return vehicleTimelines;
}

export function getBufferedRanges(): BufferedRange[] {
  if (loadedChunks.length === 0) return [];
  // Merge contiguous loaded chunks into ranges
  const sorted = [...loadedChunks].sort((a, b) => a.from - b.from);
  const ranges: BufferedRange[] = [{ from: sorted[0]!.from, to: sorted[0]!.to }];
  for (let i = 1; i < sorted.length; i++) {
    const last = ranges[ranges.length - 1]!;
    if (sorted[i]!.from <= last.to) {
      last.to = Math.max(last.to, sorted[i]!.to);
    } else {
      ranges.push({ from: sorted[i]!.from, to: sorted[i]!.to });
    }
  }
  return ranges;
}

export function isLoaded(ts: number): boolean {
  return loadedChunks.some((c) => ts >= c.from && ts < c.to);
}

export function isBuffering(): boolean {
  return inFlightChunks.size > 0;
}

/**
 * Fetch metadata for a date. Returns instantly (~1 KB).
 * This is what makes the slider render immediately.
 */
export async function fetchMeta(date: string, signal?: AbortSignal): Promise<SnapshotMeta | null> {
  await initDuckDB();
  const resp = await fetch(`/data/snapshots/${date}/meta`, { signal });
  if (!resp.ok) return null;
  const data = await resp.json();
  meta = data as SnapshotMeta;
  currentDate = date;
  return meta;
}

/**
 * Ensure the chunk containing `timestamp` is loaded.
 * Returns true if data is available, false if aborted or failed.
 */
export async function ensureLoaded(
  timestamp: number,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<boolean> {
  if (!meta) return false;
  const clampedTs = Math.max(meta.minTimestamp, Math.min(timestamp, meta.maxTimestamp));
  const { from, to } = chunkBounds(clampedTs);

  // Already loaded
  if (loadedChunks.some((c) => c.from === from && c.to === to)) return true;

  return fetchChunk(from, to, onProgress, signal);
}

/**
 * Prefetch the next chunk after the given timestamp.
 * Non-blocking — fires and returns immediately.
 * Returns a promise that resolves when the prefetch completes.
 */
export function prefetch(
  currentTimestamp: number,
  signal?: AbortSignal
): Promise<boolean> | null {
  if (!meta) return null;
  const { to: currentEnd } = chunkBounds(currentTimestamp);
  if (currentEnd > meta.maxTimestamp) return null; // at the end

  const nextFrom = currentEnd;
  const nextTo = Math.min(nextFrom + CHUNK_DURATION_S, meta.maxTimestamp + 1);
  const key = chunkKey(nextFrom, nextTo);

  // Already loaded or in-flight
  if (loadedChunks.some((c) => c.from === nextFrom && c.to === nextTo)) return null;
  if (inFlightChunks.has(key)) return null;

  return fetchChunk(nextFrom, nextTo, undefined, signal);
}

/**
 * Fetch a specific chunk range and merge into allSnapshots + timelines.
 */
async function fetchChunk(
  from: number,
  to: number,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<boolean> {
  const key = chunkKey(from, to);
  if (inFlightChunks.has(key)) return true; // already fetching
  inFlightChunks.add(key);

  try {
    onProgress?.("Downloading...");

    const resp = await fetch(
      `/data/snapshots/${currentDate}?from=${from}&to=${to}`,
      { signal }
    );
    if (!resp.ok || signal?.aborted) {
      inFlightChunks.delete(key);
      return false;
    }

    // Stream download with progress
    const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
    const reader = resp.body?.getReader();
    if (!reader) { inFlightChunks.delete(key); return false; }

    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      if (signal?.aborted) { reader.cancel(); inFlightChunks.delete(key); return false; }
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (contentLength > 0) {
        onProgress?.(`Downloading... ${Math.floor((received / contentLength) * 100)}%`);
      }
    }

    const buffer = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }

    if (signal?.aborted) { inFlightChunks.delete(key); return false; }

    onProgress?.("Decoding...");

    // Register in DuckDB-WASM and query
    const fileName = `chunk_${fileCounter++}.parquet`;
    await db!.registerFileBuffer(fileName, buffer);
    const conn = await db!.connect();

    const result = await conn.query(
      `SELECT * FROM '${fileName}' ORDER BY timestamp`
    );

    // Parse into snapshots
    const grouped = new Map<number, VehiclePosition[]>();
    for (const batch of result.batches) {
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
      }
    }

    await conn.close();
    // Drop file to free WASM memory
    await db!.dropFile(fileName);

    if (signal?.aborted) { inFlightChunks.delete(key); return false; }

    // Merge into allSnapshots (sorted insert)
    const newSnapshots = [...grouped.keys()]
      .sort((a, b) => a - b)
      .map((ts) => ({ timestamp: ts, vehicles: grouped.get(ts)! }));
    grouped.clear();

    if (newSnapshots.length === 0) {
      // Empty chunk — still record it as loaded so we don't re-fetch
      loadedChunks.push({
        from, to,
        snapshotStartIdx: -1, snapshotEndIdx: -1,
        loadedAt: Date.now(),
      });
      inFlightChunks.delete(key);
      return true;
    }

    // Find insertion point in allSnapshots
    const insertAt = findInsertionIndex(newSnapshots[0]!.timestamp);
    allSnapshots.splice(insertAt, 0, ...newSnapshots);

    // Update existing chunk indices that shifted
    for (const c of loadedChunks) {
      if (c.snapshotStartIdx >= insertAt) {
        c.snapshotStartIdx += newSnapshots.length;
        c.snapshotEndIdx += newSnapshots.length;
      }
    }

    loadedChunks.push({
      from, to,
      snapshotStartIdx: insertAt,
      snapshotEndIdx: insertAt + newSnapshots.length - 1,
      loadedAt: Date.now(),
    });

    // Build/extend vehicle timelines for new snapshots
    onProgress?.("Building timelines...");
    for (let si = 0; si < newSnapshots.length; si++) {
      const snap = newSnapshots[si]!;
      for (const v of snap.vehicles) {
        let tl = vehicleTimelines.get(v.entityId);
        if (!tl) {
          tl = { entityId: v.entityId, waypoints: [], nextIdx: 0 };
          vehicleTimelines.set(v.entityId, tl);
        }
        // Insert waypoint in sorted position
        const last = tl.waypoints[tl.waypoints.length - 1];
        if (!last || snap.timestamp > last.ts) {
          // Append (most common path — chunks load in order)
          if (!last || Math.abs(v.latitude - last.lat) > 0.0001 || Math.abs(v.longitude - last.lon) > 0.0001) {
            tl.waypoints.push({ ts: snap.timestamp, lat: v.latitude, lon: v.longitude });
          }
        } else {
          // Out-of-order insert (backward seek loaded an earlier chunk)
          insertWaypoint(tl, snap.timestamp, v.latitude, v.longitude);
        }
      }
    }

    // Evict old chunks if we have too many
    evict();

    inFlightChunks.delete(key);
    return true;
  } catch (error) {
    inFlightChunks.delete(key);
    if (error instanceof DOMException && error.name === "AbortError") return false;
    console.error("[chunks] Failed to load chunk:", error);
    return false;
  }
}

/** Insert a waypoint in sorted-by-timestamp order, deduplicating by position */
function insertWaypoint(
  tl: VehicleTimeline,
  ts: number,
  lat: number,
  lon: number
): void {
  // Binary search for insertion point
  let lo = 0, hi = tl.waypoints.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tl.waypoints[mid]!.ts < ts) lo = mid + 1;
    else hi = mid;
  }
  // Check neighbors for position deduplication
  const prev = lo > 0 ? tl.waypoints[lo - 1] : null;
  const next = lo < tl.waypoints.length ? tl.waypoints[lo] : null;
  if (prev && Math.abs(lat - prev.lat) < 0.0001 && Math.abs(lon - prev.lon) < 0.0001) return;
  if (next && next.ts === ts) return; // exact timestamp duplicate
  tl.waypoints.splice(lo, 0, { ts, lat, lon });
}

function findInsertionIndex(ts: number): number {
  let lo = 0, hi = allSnapshots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (allSnapshots[mid]!.timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Current playback timestamp — set by the playback engine so eviction can protect it */
let currentPlaybackTs = 0;

export function setCurrentPlaybackTs(ts: number): void {
  currentPlaybackTs = ts;
}

/** Evict the oldest/farthest chunks when we exceed the adaptive limit */
function evict(): void {
  const maxChunks = getMaxChunks();
  while (loadedChunks.length > maxChunks) {
    // Find the oldest chunk that does NOT contain the current playback position
    let oldestIdx = -1;
    for (let i = 0; i < loadedChunks.length; i++) {
      const c = loadedChunks[i]!;
      // Protect the chunk the user is currently playing/viewing
      if (currentPlaybackTs >= c.from && currentPlaybackTs < c.to) continue;
      if (oldestIdx === -1 || c.loadedAt < loadedChunks[oldestIdx]!.loadedAt) {
        oldestIdx = i;
      }
    }
    if (oldestIdx === -1) break; // all chunks are protected — don't evict
    evictChunk(oldestIdx);
  }
}

function evictChunk(idx: number): void {
  const chunk = loadedChunks[idx]!;
  if (chunk.snapshotStartIdx < 0) {
    // Empty chunk — just remove tracking
    loadedChunks.splice(idx, 1);
    return;
  }

  const count = chunk.snapshotEndIdx - chunk.snapshotStartIdx + 1;
  allSnapshots.splice(chunk.snapshotStartIdx, count);

  // Update indices for remaining chunks
  loadedChunks.splice(idx, 1);
  for (const c of loadedChunks) {
    if (c.snapshotStartIdx > chunk.snapshotStartIdx) {
      c.snapshotStartIdx -= count;
      c.snapshotEndIdx -= count;
    }
  }

  // Note: we don't clean up vehicleTimelines on eviction — the waypoints
  // remain but take minimal memory. Timelines are fully rebuilt on reset.
}

/** Find the snapshot index closest to (but not after) the given timestamp */
export function findSnapshotIndex(ts: number): number {
  let lo = 0, hi = allSnapshots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (allSnapshots[mid]!.timestamp <= ts) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Reset all state — called when exiting playback or switching dates */
export function resetChunks(): void {
  if (abortController) { abortController.abort(); abortController = null; }
  inFlightChunks.clear();
  allSnapshots = [];
  loadedChunks = [];
  vehicleTimelines.clear();
  meta = null;
  currentDate = "";
}

/** Cancel all in-flight fetches */
export function cancelFetches(): void {
  if (abortController) { abortController.abort(); }
  abortController = new AbortController();
  inFlightChunks.clear();
  return;
}

/** Get a fresh abort signal for fetch operations */
export function getAbortSignal(): AbortSignal {
  if (!abortController) abortController = new AbortController();
  return abortController.signal;
}
