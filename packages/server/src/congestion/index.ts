/**
 * Congestion tracker: accumulates per-route-segment speed observations
 * over a sliding window and produces segment average speeds for the
 * heatmap overlay.
 *
 * Called from processSnapshot() when fresh feed data arrives.
 * Results included in every WorldState broadcast.
 */

import type { VehiclePosition, TransportMode, SegmentSpeed } from "../types.js";

// ── Config ──

/** Segment length in meters */
const SEGMENT_LEN = 200;

/** Sliding window in seconds — only observations within this window count */
const WINDOW_S = 600; // 10 minutes

/** Minimum samples before a segment is reported (avoid noise from single readings) */
const MIN_SAMPLES = 2;

// ── Types ──

interface SpeedSample {
  ts: number;     // POSIX seconds
  speed: number;  // m/s
}

interface RouteSegments {
  mode: TransportMode;
  /** Per-segment ring buffer of speed samples */
  segments: Map<number, SpeedSample[]>;
}

// ── State ──

const routes = new Map<string, RouteSegments>();

/** Track per-vehicle previous position for speed calculation */
const prevPositions = new Map<string, { dist: number; ts: number; routeId: string }>();

// ── API ──

/**
 * Record vehicle positions from a fresh poll.
 * Calculates speed from consecutive position changes and records
 * into the appropriate route segment.
 */
export function recordCongestion(vehicles: VehiclePosition[], headerTimestamp: number): void {
  for (const v of vehicles) {
    if (v.stale || v.shapeDistTraveled < 0) continue;

    const prev = prevPositions.get(v.entityId);
    prevPositions.set(v.entityId, {
      dist: v.shapeDistTraveled,
      ts: v.timestamp,
      routeId: v.routeId,
    });

    if (!prev || prev.routeId !== v.routeId) continue;

    const dt = v.timestamp - prev.ts;
    if (dt <= 0 || dt > 300) continue; // skip stale gaps (>5 min)

    const dd = Math.abs(v.shapeDistTraveled - prev.dist);
    const speed = dd / dt; // m/s

    // Record speed in every segment the vehicle traversed
    const fromDist = Math.min(prev.dist, v.shapeDistTraveled);
    const toDist = Math.max(prev.dist, v.shapeDistTraveled);
    const fromSeg = Math.floor(fromDist / SEGMENT_LEN);
    const toSeg = Math.floor(toDist / SEGMENT_LEN);

    let route = routes.get(v.routeId);
    if (!route) {
      route = { mode: v.mode, segments: new Map() };
      routes.set(v.routeId, route);
    }

    for (let seg = fromSeg; seg <= toSeg; seg++) {
      let buf = route.segments.get(seg);
      if (!buf) {
        buf = [];
        route.segments.set(seg, buf);
      }
      buf.push({ ts: v.timestamp, speed });

      // Cap buffer size (10 min at ~30s intervals = ~20 samples per vehicle,
      // multiple vehicles per segment, cap at 100)
      if (buf.length > 100) buf.splice(0, buf.length - 100);
    }
  }

  // Prune departed vehicles
  const activeIds = new Set(vehicles.map(v => v.entityId));
  for (const key of prevPositions.keys()) {
    if (!activeIds.has(key)) prevPositions.delete(key);
  }
}

/**
 * Get current congestion data: per-segment average speeds
 * within the sliding window. Only segments with enough samples
 * are included.
 */
export function getCongestion(nowTimestamp: number): SegmentSpeed[] {
  const cutoff = nowTimestamp - WINDOW_S;
  const result: SegmentSpeed[] = [];

  for (const [routeId, route] of routes) {
    for (const [segIdx, samples] of route.segments) {
      // Filter to samples within window
      let sum = 0, count = 0;
      let firstValid = samples.length;

      for (let i = samples.length - 1; i >= 0; i--) {
        if (samples[i]!.ts >= cutoff) {
          sum += samples[i]!.speed;
          count++;
          firstValid = i;
        } else {
          break; // samples are roughly chronological
        }
      }

      // Prune old samples
      if (firstValid > 0) samples.splice(0, firstValid);

      if (count >= MIN_SAMPLES) {
        result.push({
          routeId,
          mode: route.mode,
          segIdx,
          avgSpeed: sum / count,
          sampleCount: count,
        });
      }
    }
  }

  return result;
}

/** Clear all state (used on shutdown) */
export function clearCongestion(): void {
  routes.clear();
  prevPositions.clear();
}

/** Segment length exported for client alignment */
export const CONGESTION_SEGMENT_LEN = SEGMENT_LEN;
