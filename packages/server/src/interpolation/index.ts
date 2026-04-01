import type { VehiclePosition, ShapePolyline } from "../types.js";
import { config } from "../config.js";
import { haversineDistance } from "./geo.js";
import {
  getShapeForTrip,
  getShapesForRoute,
  snapToShape,
  sampleShape,
  shapeLength,
} from "../shapes/index.js";

// ── 30s delayed playback buffer ──

const PLAYBACK_DELAY_S = 30;
const MAX_BUFFER_AGE_S = 90;

interface Snapshot {
  timestamp: number;
  vehicles: Map<string, VehiclePosition>;
}

const snapshotBuffer: Snapshot[] = [];

// ── Per-vehicle shape lock ──

const vehicleShapes = new Map<string, ShapePolyline | null>();

function getOrPickShape(entityId: string, tripId: string, routeId: string, lat: number, lon: number): ShapePolyline | null {
  if (vehicleShapes.has(entityId)) return vehicleShapes.get(entityId)!;

  // Try trip_id match first, then route_id with dual-direction selection
  const tripShape = getShapeForTrip(tripId);
  if (tripShape && tripShape.length >= 2) {
    vehicleShapes.set(entityId, tripShape);
    return tripShape;
  }

  const { dir0, dir1 } = getShapesForRoute(routeId);
  if (!dir0 && !dir1) { vehicleShapes.set(entityId, null); return null; }
  if (dir0 && !dir1) { vehicleShapes.set(entityId, dir0); return dir0; }
  if (!dir0 && dir1) { vehicleShapes.set(entityId, dir1); return dir1; }

  const snap0 = snapToShape(lat, lon, dir0!);
  const pos0 = sampleShape(dir0!, snap0);
  const d0 = pos0 ? haversineDistance(lat, lon, pos0.lat, pos0.lon) : Infinity;

  const snap1 = snapToShape(lat, lon, dir1!);
  const pos1 = sampleShape(dir1!, snap1);
  const d1 = pos1 ? haversineDistance(lat, lon, pos1.lat, pos1.lon) : Infinity;

  const shape = d0 <= d1 ? dir0! : dir1!;
  vehicleShapes.set(entityId, shape);
  return shape;
}

// ── Process a fresh poll ──

export function processSnapshot(
  vehicles: VehiclePosition[],
  headerTimestamp: number
): VehiclePosition[] {

  for (const v of vehicles) {
    const age = headerTimestamp - v.timestamp;
    v.stale = age * 1000 > config.staleVehicleThresholdMs;

    const shape = getOrPickShape(v.entityId, v.tripId, v.routeId, v.latitude, v.longitude);

    if (shape && shape.length >= 2) {
      const snapDist = snapToShape(v.latitude, v.longitude, shape);
      const snapped = sampleShape(shape, snapDist);
      if (snapped) { v.latitude = snapped.lat; v.longitude = snapped.lon; }
      v.shapeDistTraveled = snapDist;
      v.shapeId = v.tripId || v.routeId;
    } else {
      v.shapeDistTraveled = -1;
      v.shapeId = "";
    }
  }

  // Store in buffer
  const vehicleMap = new Map<string, VehiclePosition>();
  for (const v of vehicles) vehicleMap.set(v.entityId, { ...v });
  snapshotBuffer.push({ timestamp: headerTimestamp, vehicles: vehicleMap });

  // Trim old + clean departed
  const cutoff = headerTimestamp - MAX_BUFFER_AGE_S;
  while (snapshotBuffer.length > 0 && snapshotBuffer[0]!.timestamp < cutoff) snapshotBuffer.shift();

  const currentIds = new Set(vehicles.map((v) => v.entityId));
  for (const key of vehicleShapes.keys()) {
    if (!currentIds.has(key)) vehicleShapes.delete(key);
  }

  return vehicles;
}

// ── Average speed over recent snapshots ──
// Looks back up to AVG_SPEED_LOOKBACK snapshots from snapBIdx for a given vehicle.
// Uses total distance / total time for a stable average.
const AVG_SPEED_LOOKBACK = 4; // ~60s at 15s poll intervals

function avgSpeedOverHistory(entityId: string, currentDist: number, snapBIdx: number): number {
  // Walk backwards to find the oldest snapshot that has this vehicle
  let oldest: { dist: number; timestamp: number } | null = null;
  let newest: { dist: number; timestamp: number } | null = null;

  const end = snapBIdx;
  const start = Math.max(0, end - AVG_SPEED_LOOKBACK);

  for (let i = end; i >= start; i--) {
    const snap = snapshotBuffer[i];
    if (!snap) continue;
    const v = snap.vehicles.get(entityId);
    if (!v || v.shapeDistTraveled < 0) continue;
    if (!newest) newest = { dist: v.shapeDistTraveled, timestamp: v.timestamp };
    oldest = { dist: v.shapeDistTraveled, timestamp: v.timestamp };
  }

  if (!oldest || !newest || oldest === newest) return 0;
  const dt = newest.timestamp - oldest.timestamp;
  if (dt <= 0) return 0;
  return Math.abs(newest.dist - oldest.dist) / dt;
}

// ── Interpolate for broadcast (30s delayed playback) ──

export function interpolate(vehicles: VehiclePosition[]): VehiclePosition[] {
  if (snapshotBuffer.length === 0) return vehicles;

  // Use a millisecond playback cursor so consecutive ~1s broadcasts do not
  // quantize onto whole-second positions. That quantization produced visible
  // start/stop motion in live mode whenever two broadcasts landed in the same
  // rounded second.
  const playbackTimeMs = Date.now() - (PLAYBACK_DELAY_S * 1000);

  // Find two snapshots straddling playbackTimeMs
  let snapA: Snapshot | null = null;
  let snapB: Snapshot | null = null;

  let snapBIdx = -1;
  for (let i = 0; i < snapshotBuffer.length - 1; i++) {
    const snapATimeMs = snapshotBuffer[i]!.timestamp * 1000;
    const snapBTimeMs = snapshotBuffer[i + 1]!.timestamp * 1000;
    if (snapATimeMs <= playbackTimeMs && snapBTimeMs > playbackTimeMs) {
      snapA = snapshotBuffer[i]!;
      snapB = snapshotBuffer[i + 1]!;
      snapBIdx = i + 1;
      break;
    }
  }

  // Warmup — serve latest
  if (!snapA || !snapB) {
    const latest = snapshotBuffer[snapshotBuffer.length - 1]!;
    return [...latest.vehicles.values()].sort((a, b) =>
      a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0
    );
  }

  const snapATimeMs = snapA.timestamp * 1000;
  const snapBTimeMs = snapB.timestamp * 1000;
  const spanMs = snapBTimeMs - snapATimeMs;
  const t = spanMs > 0 ? (playbackTimeMs - snapATimeMs) / spanMs : 0;

  const result: VehiclePosition[] = [];

  for (const [entityId, vB] of snapB.vehicles) {
    const vA = snapA.vehicles.get(entityId);
    if (!vA) { result.push({ ...vB }); continue; }

    const shape = getOrPickShape(entityId, vB.tripId, vB.routeId, vB.latitude, vB.longitude);

    if (shape && shape.length >= 2 && vA.shapeDistTraveled >= 0 && vB.shapeDistTraveled >= 0) {
      const lerpDist = vA.shapeDistTraveled + t * (vB.shapeDistTraveled - vA.shapeDistTraveled);
      const clampedDist = Math.max(0, Math.min(lerpDist, shapeLength(shape)));
      const pos = sampleShape(shape, clampedDist);

      if (pos) {
        // Average speed over recent snapshots (smoother than instant speed)
        const speed = avgSpeedOverHistory(entityId, vB.shapeDistTraveled, snapBIdx);
        result.push({
          ...vB,
          latitude: pos.lat,
          longitude: pos.lon,
          speed,
          shapeDistTraveled: clampedDist,
        });
        continue;
      }
    }

    // Fallback: straight-line lerp
    result.push({
      ...vB,
      latitude: vA.latitude + t * (vB.latitude - vA.latitude),
      longitude: vA.longitude + t * (vB.longitude - vA.longitude),
    });
  }

  result.sort((a, b) => a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0);
  return result;
}
