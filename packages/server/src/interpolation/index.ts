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

// ── Interpolate for broadcast (30s delayed playback) ──

export function interpolate(vehicles: VehiclePosition[]): VehiclePosition[] {
  if (snapshotBuffer.length === 0) return vehicles;

  const nowS = Math.floor(Date.now() / 1000);
  const playbackTime = nowS - PLAYBACK_DELAY_S;

  // Find two snapshots straddling playbackTime
  let snapA: Snapshot | null = null;
  let snapB: Snapshot | null = null;

  for (let i = 0; i < snapshotBuffer.length - 1; i++) {
    if (snapshotBuffer[i]!.timestamp <= playbackTime && snapshotBuffer[i + 1]!.timestamp > playbackTime) {
      snapA = snapshotBuffer[i]!;
      snapB = snapshotBuffer[i + 1]!;
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

  const span = snapB.timestamp - snapA.timestamp;
  const t = span > 0 ? (playbackTime - snapA.timestamp) / span : 0;

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
        // Use per-vehicle timestamps for speed (more accurate than header span
        // when the feed caches data or vehicles report at different rates)
        const vSpan = vB.timestamp - vA.timestamp;
        const speed = vSpan > 0 ? Math.abs(vB.shapeDistTraveled - vA.shapeDistTraveled) / vSpan : 0;
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
