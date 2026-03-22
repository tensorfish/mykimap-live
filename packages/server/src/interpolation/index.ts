import type { VehiclePosition, TransportMode, ShapePolyline } from "../types.js";
import { config } from "../config.js";
import { haversineDistance, calculateBearing } from "./geo.js";
import {
  getShapeForTrip,
  getShapesForRoute,
  snapToShape,
  sampleShape,
  sampleShapeSegment,
  shapeLength,
} from "../shapes/index.js";

// ── Playback buffer ──
//
// Architecture: 30s delayed playback (see .memory/ui-stabilizing.md)
//
// Instead of predicting the future, we serve data from 30s ago.
// Since the feed refreshes every ~30s, by the time we serve a position
// to the client, we already have the NEXT position.
// The server interpolates between two KNOWN positions — no speculation.
//
// Result: zero prediction error, zero overshoot, zero snap-back.

const PLAYBACK_DELAY_S = 30;
const MAX_BUFFER_AGE_S = 90; // keep 90s of history

interface Snapshot {
  /** Feed header timestamp (POSIX seconds) */
  timestamp: number;
  /** Vehicles keyed by entityId for fast lookup */
  vehicles: Map<string, VehiclePosition>;
}

const snapshotBuffer: Snapshot[] = [];

// ── Per-vehicle persistent state (shape locking, trail) ──

interface VehicleShapeState {
  shape: ShapePolyline | null;
}

const vehicleShapes = new Map<string, VehicleShapeState>();

// ── Trail history (from poll data only) ──

const TRAIL_LENGTH: Record<TransportMode, number> = {
  metro: 30, vline: 30, tram: 60, bus: 80,
};

const vehicleTrails = new Map<string, Array<[number, number]>>();

function appendTrail(entityId: string, lon: number, lat: number, mode: TransportMode): void {
  let trail = vehicleTrails.get(entityId);
  if (!trail) { trail = []; vehicleTrails.set(entityId, trail); }
  const last = trail[trail.length - 1];
  if (!last || Math.abs(last[0] - lon) > 1e-7 || Math.abs(last[1] - lat) > 1e-7) {
    trail.push([lon, lat]);
    if (trail.length > TRAIL_LENGTH[mode]) {
      trail.splice(0, trail.length - TRAIL_LENGTH[mode]);
    }
  }
}

export function getTrails(): Record<string, Array<[number, number]>> {
  const result: Record<string, Array<[number, number]>> = {};
  for (const [id, trail] of vehicleTrails) {
    if (trail.length >= 2) result[id] = trail;
  }
  return result;
}

// ── Shape helpers ──

function bearingAtDist(shape: ShapePolyline, dist: number, direction: number): number {
  if (shape.length < 2) return 0;

  let a = shape[0]!, b = shape[1]!;
  for (let i = 0; i < shape.length - 1; i++) {
    if (dist >= shape[i]!.dist && dist <= shape[i + 1]!.dist) {
      a = shape[i]!; b = shape[i + 1]!; break;
    }
  }
  if (dist > shape[shape.length - 1]!.dist) {
    a = shape[shape.length - 2]!; b = shape[shape.length - 1]!;
  }

  let bearing = calculateBearing(a.lat, a.lon, b.lat, b.lon);
  if (direction < 0) bearing = (bearing + 180) % 360;
  return bearing;
}

function pickShape(tripId: string, routeId: string, lat: number, lon: number): ShapePolyline | null {
  const tripShape = getShapeForTrip(tripId);
  if (tripShape && tripShape.length >= 2) return tripShape;

  const { dir0, dir1 } = getShapesForRoute(routeId);
  if (!dir0 && !dir1) return null;
  if (dir0 && !dir1) return dir0;
  if (!dir0 && dir1) return dir1;

  const snap0 = snapToShape(lat, lon, dir0!);
  const pos0 = sampleShape(dir0!, snap0);
  const d0 = pos0 ? haversineDistance(lat, lon, pos0.lat, pos0.lon) : Infinity;

  const snap1 = snapToShape(lat, lon, dir1!);
  const pos1 = sampleShape(dir1!, snap1);
  const d1 = pos1 ? haversineDistance(lat, lon, pos1.lat, pos1.lon) : Infinity;

  return d0 <= d1 ? dir0! : dir1!;
}

function getOrPickShape(entityId: string, tripId: string, routeId: string, lat: number, lon: number): ShapePolyline | null {
  const existing = vehicleShapes.get(entityId);
  if (existing) return existing.shape;

  const shape = pickShape(tripId, routeId, lat, lon);
  vehicleShapes.set(entityId, { shape });
  return shape;
}

// ── Process a fresh poll → snap + store in buffer ──

export function processSnapshot(
  vehicles: VehiclePosition[],
  headerTimestamp: number
): VehiclePosition[] {

  // Snap each vehicle to its shape
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

      // Set prevShapeDistTraveled from the last snapshot in the buffer
      const lastSnap = snapshotBuffer.length > 0 ? snapshotBuffer[snapshotBuffer.length - 1] : null;
      const prevVehicle = lastSnap?.vehicles.get(v.entityId);
      v.prevShapeDistTraveled = prevVehicle?.shapeDistTraveled ?? snapDist;
    } else {
      v.shapeDistTraveled = -1;
      v.prevShapeDistTraveled = -1;
      v.shapeId = "";
    }

    // Trail: append ground-truth snapped position
    if (!v.stale) appendTrail(v.entityId, v.longitude, v.latitude, v.mode);
  }

  // Store in buffer
  const vehicleMap = new Map<string, VehiclePosition>();
  for (const v of vehicles) vehicleMap.set(v.entityId, { ...v });

  snapshotBuffer.push({ timestamp: headerTimestamp, vehicles: vehicleMap });

  // Trim old snapshots
  const cutoff = headerTimestamp - MAX_BUFFER_AGE_S;
  while (snapshotBuffer.length > 0 && snapshotBuffer[0]!.timestamp < cutoff) {
    snapshotBuffer.shift();
  }

  // Clean up departed vehicle shapes
  const currentIds = new Set(vehicles.map((v) => v.entityId));
  for (const key of vehicleShapes.keys()) {
    if (!currentIds.has(key)) vehicleShapes.delete(key);
  }
  for (const key of vehicleTrails.keys()) {
    if (!currentIds.has(key)) vehicleTrails.delete(key);
  }

  return vehicles;
}

// ── Per-vehicle last broadcast distance (for path segment generation) ──

const lastBroadcastDist = new Map<string, number>();

// ── Interpolate for broadcast (30s delayed playback) ──
//
// Finds two snapshots straddling (now - 30s), lerps between them.
// Every position is between two known ground-truth points.
// Generates a pathSegment per vehicle: the actual route geometry
// between the previous and current broadcast positions.

export function interpolate(vehicles: VehiclePosition[]): VehiclePosition[] {
  if (snapshotBuffer.length === 0) return vehicles;

  const nowS = Math.floor(Date.now() / 1000);
  const playbackTime = nowS - PLAYBACK_DELAY_S;

  // Find snapshots A (before) and B (after) straddling playbackTime
  let snapA: Snapshot | null = null;
  let snapB: Snapshot | null = null;

  for (let i = 0; i < snapshotBuffer.length - 1; i++) {
    if (snapshotBuffer[i]!.timestamp <= playbackTime && snapshotBuffer[i + 1]!.timestamp > playbackTime) {
      snapA = snapshotBuffer[i]!;
      snapB = snapshotBuffer[i + 1]!;
      break;
    }
  }

  // Not enough buffer yet — serve latest snapshot directly (warmup period)
  if (!snapA || !snapB) {
    const latest = snapshotBuffer[snapshotBuffer.length - 1]!;
    return [...latest.vehicles.values()].map(v => ({ ...v, pathSegment: [] })).sort((a, b) =>
      a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0
    );
  }

  // Lerp factor: 0 = at A, 1 = at B
  const span = snapB.timestamp - snapA.timestamp;
  const t = span > 0 ? (playbackTime - snapA.timestamp) / span : 0;

  const result: VehiclePosition[] = [];

  // Interpolate each vehicle that exists in both snapshots
  // Clean departed vehicles from tracking
  const activeIds = new Set(snapB.vehicles.keys());
  for (const key of lastBroadcastDist.keys()) {
    if (!activeIds.has(key)) lastBroadcastDist.delete(key);
  }

  for (const [entityId, vB] of snapB.vehicles) {
    const vA = snapA.vehicles.get(entityId);
    if (!vA) {
      result.push({ ...vB, pathSegment: [] });
      continue;
    }

    const shape = getOrPickShape(entityId, vB.tripId, vB.routeId, vB.latitude, vB.longitude);

    if (shape && shape.length >= 2 && vA.shapeDistTraveled >= 0 && vB.shapeDistTraveled >= 0) {
      // Lerp along shape between two known positions
      const distA = vA.shapeDistTraveled;
      const distB = vB.shapeDistTraveled;
      const lerpDist = distA + t * (distB - distA);
      const clampedDist = Math.max(0, Math.min(lerpDist, shapeLength(shape)));

      const pos = sampleShape(shape, clampedDist);
      if (pos) {
        const direction = distB >= distA ? 1 : -1;
        const bearing = bearingAtDist(shape, clampedDist, direction);
        const speed = span > 0 ? Math.abs(distB - distA) / span : 0;

        // Generate path segment between last broadcast position and current.
        // Sanity check: if the shape distance jumped too far (wrong snap,
        // loop route, or shape mismatch), the path segment would cut across
        // the map through buildings. Cap to reasonable max per tick.
        const prevDist = lastBroadcastDist.get(entityId) ?? clampedDist;
        const segShapeDist = Math.abs(clampedDist - prevDist);
        // Max reasonable movement per broadcast tick: speed × 2s (generous)
        const maxSegDist = speed * 2;
        let pathSegment: Array<[number, number]> = [];

        if (!vB.stale && speed >= 0.5 && segShapeDist <= maxSegDist && segShapeDist > 0.1) {
          pathSegment = sampleShapeSegment(shape, prevDist, clampedDist);

          // Extra sanity: if the path segment is wildly longer than the
          // straight-line distance between endpoints, it's a bad match
          if (pathSegment.length >= 2) {
            const startPt = pathSegment[0]!;
            const endPt = pathSegment[pathSegment.length - 1]!;
            const straightDist = haversineDistance(startPt[1], startPt[0], endPt[1], endPt[0]);
            // If path is > 5× the straight-line distance and > 200m, it's cutting across
            if (straightDist > 200 && segShapeDist > straightDist * 5) {
              pathSegment = [];
            }
          }
        }

        lastBroadcastDist.set(entityId, clampedDist);

        // Trail from shape-interpolated positions (on-route)
        if (!vB.stale && speed >= 0.5) {
          appendTrail(entityId, pos.lon, pos.lat, vB.mode);
        }

        result.push({
          ...vB,
          latitude: pos.lat,
          longitude: pos.lon,
          bearing,
          speed,
          shapeDistTraveled: clampedDist,
          stale: vB.stale,
          pathSegment,
        });
        continue;
      }
    }

    // Fallback: straight-line lerp between raw positions
    const lat = vA.latitude + t * (vB.latitude - vA.latitude);
    const lon = vA.longitude + t * (vB.longitude - vA.longitude);
    if (!vB.stale && vB.speed >= 0.5) {
      appendTrail(entityId, lon, lat, vB.mode);
    }
    result.push({
      ...vB,
      latitude: lat,
      longitude: lon,
      bearing: vB.bearing,
      speed: vB.speed,
      pathSegment: [], // No shape — client will straight-line lerp
    });
  }

  // Sort for stable client rendering
  result.sort((a, b) => a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0);

  return result;
}
