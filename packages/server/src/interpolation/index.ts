import type { VehiclePosition, TransportMode, ShapePolyline } from "../types.js";
import { config } from "../config.js";
import { haversineDistance, calculateBearing } from "./geo.js";
import {
  getShapeForTrip,
  getShapesForRoute,
  snapToShape,
  sampleShape,
  shapeLength,
} from "../shapes/index.js";

// ── Per-vehicle state ──
//
// Architecture: single-layer prediction (see .memory/ui-stabilizing.md)
// - shapeDist is the BASELINE — advanced by exactly 1s per broadcast beat
// - On fresh poll, shapeDist resets to ground truth (snapped GPS)
// - No elapsed-based accumulation — no overshoot possible

interface VehicleState {
  /** Current baseline distance along shape (advanced each beat, reset on poll) */
  shapeDist: number;
  /** Ground truth shapeDist from last fresh poll */
  lastPollShapeDist: number;
  /** Last poll timestamp (for speed calculation) */
  lastPollTimestamp: number;
  /** Locked shape reference — chosen on first sighting, never re-picked */
  shape: ShapePolyline | null;
  /** Speed in m/s from consecutive polls */
  speed: number;
  /** +1 or -1 along shape polyline */
  direction: number;
  /** Bearing from shape geometry + direction */
  bearing: number;
}

const vehicleStates = new Map<string, VehicleState>();

// ── Trail history (from poll data only — never from interpolation) ──

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

/** Find bearing at a distance along a shape. Clean search-then-fallback (Step A fix). */
function bearingAtDist(
  shape: ShapePolyline,
  dist: number,
  direction: number
): number {
  if (shape.length < 2) return 0;

  // Default: first segment
  let a = shape[0]!;
  let b = shape[1]!;

  // Search for the segment containing this distance
  for (let i = 0; i < shape.length - 1; i++) {
    if (dist >= shape[i]!.dist && dist <= shape[i + 1]!.dist) {
      a = shape[i]!;
      b = shape[i + 1]!;
      break;
    }
  }

  // If past the end, use last segment
  if (dist > shape[shape.length - 1]!.dist) {
    a = shape[shape.length - 2]!;
    b = shape[shape.length - 1]!;
  }

  let bearing = calculateBearing(a.lat, a.lon, b.lat, b.lon);
  if (direction < 0) bearing = (bearing + 180) % 360;
  return bearing;
}

/**
 * Pick the best shape for a vehicle on first sighting.
 * Tries trip_id match first. Falls back to route_id with dual-direction
 * selection — snaps to both dir0 and dir1, picks whichever is closest.
 */
function pickShape(
  tripId: string,
  routeId: string,
  lat: number,
  lon: number
): ShapePolyline | null {
  // Primary: exact trip_id match
  const tripShape = getShapeForTrip(tripId);
  if (tripShape && tripShape.length >= 2) return tripShape;

  // Fallback: route_id with dual-direction selection
  const { dir0, dir1 } = getShapesForRoute(routeId);
  if (!dir0 && !dir1) return null;
  if (dir0 && !dir1) return dir0;
  if (!dir0 && dir1) return dir1;

  // Both exist — snap to each, pick closest
  const snap0 = snapToShape(lat, lon, dir0!);
  const pos0 = sampleShape(dir0!, snap0);
  const d0 = pos0 ? haversineDistance(lat, lon, pos0.lat, pos0.lon) : Infinity;

  const snap1 = snapToShape(lat, lon, dir1!);
  const pos1 = sampleShape(dir1!, snap1);
  const d1 = pos1 ? haversineDistance(lat, lon, pos1.lat, pos1.lon) : Infinity;

  return d0 <= d1 ? dir0! : dir1!;
}

// ── Process a fresh poll ──

export function processSnapshot(
  vehicles: VehiclePosition[],
  headerTimestamp: number
): VehiclePosition[] {
  const now = headerTimestamp || Math.floor(Date.now() / 1000);

  for (const v of vehicles) {
    const prev = vehicleStates.get(v.entityId);
    const age = now - v.timestamp;
    v.stale = age * 1000 > config.staleVehicleThresholdMs;

    // Get or pick shape (locked on first sighting)
    const shape = prev?.shape ?? pickShape(v.tripId, v.routeId, v.latitude, v.longitude);

    if (shape && shape.length >= 2) {
      const snapDist = snapToShape(v.latitude, v.longitude, shape);
      const snapped = sampleShape(shape, snapDist);
      if (snapped) {
        v.latitude = snapped.lat;
        v.longitude = snapped.lon;
      }
      v.shapeDistTraveled = snapDist;
      v.shapeId = v.tripId || v.routeId;

      if (prev) {
        const dt = v.timestamp - prev.lastPollTimestamp;
        if (dt > 0) {
          // Fresh data — calculate speed + direction from shape distance delta
          const shapeDelta = snapDist - prev.lastPollShapeDist;
          const dist = Math.abs(shapeDelta);
          const direction = shapeDelta >= 0 ? 1 : -1;
          const maxSpeed = v.mode === "metro" || v.mode === "vline" ? 33.3 : 22.2;
          const speed = Math.min(dist / dt, maxSpeed);
          const bearing = bearingAtDist(shape, snapDist, direction);

          // Trail: append from snapped poll position (ground truth)
          if (!v.stale) appendTrail(v.entityId, v.longitude, v.latitude, v.mode);

          vehicleStates.set(v.entityId, {
            shapeDist: snapDist, // reset baseline to ground truth
            lastPollShapeDist: snapDist,
            lastPollTimestamp: v.timestamp,
            shape,
            speed,
            direction,
            bearing,
          });

          v.speed = speed;
          v.bearing = bearing;
        } else {
          // Duplicate poll — carry forward
          v.speed = prev.speed;
          v.bearing = prev.bearing;
        }
      } else {
        // First sighting — no speed yet
        const bearing = bearingAtDist(shape, snapDist, 1);
        if (!v.stale) appendTrail(v.entityId, v.longitude, v.latitude, v.mode);

        vehicleStates.set(v.entityId, {
          shapeDist: snapDist,
          lastPollShapeDist: snapDist,
          lastPollTimestamp: v.timestamp,
          shape,
          speed: 0,
          direction: 1,
          bearing,
        });

        v.speed = 0;
        v.bearing = bearing;
      }
    } else {
      // No shape — straight-line fallback
      v.shapeDistTraveled = -1;
      v.shapeId = "";

      if (prev && !prev.shape) {
        const dt = v.timestamp - prev.lastPollTimestamp;
        if (dt > 0) {
          const dist = haversineDistance(prev.shapeDist === -1 ? 0 : prev.lastPollShapeDist, 0, v.latitude, v.longitude);
          // Use raw position delta for bearing
          v.bearing = calculateBearing(
            vehicleStates.get(v.entityId)?.bearing ? prev.lastPollShapeDist : v.latitude,
            0, v.latitude, v.longitude
          );
          v.speed = 0; // Can't interpolate without shape
        }
      }

      vehicleStates.set(v.entityId, {
        shapeDist: -1,
        lastPollShapeDist: -1,
        lastPollTimestamp: v.timestamp,
        shape: null,
        speed: 0,
        direction: 1,
        bearing: v.bearing,
      });
    }
  }

  // Clean up departed
  const currentIds = new Set(vehicles.map((v) => v.entityId));
  for (const key of vehicleStates.keys()) {
    if (!currentIds.has(key)) vehicleStates.delete(key);
  }
  for (const key of vehicleTrails.keys()) {
    if (!currentIds.has(key)) vehicleTrails.delete(key);
  }

  return vehicles;
}

// ── Interpolate for broadcast (1s beat advancement) ──
//
// Advances each vehicle along its shape by exactly speed × 1s.
// The shapeDist baseline is MUTATED — each beat moves it forward.
// On the next fresh poll, it resets to ground truth.
// Trail is NOT appended here — only in processSnapshot.

export function interpolate(vehicles: VehiclePosition[]): VehiclePosition[] {
  return vehicles.map((v) => {
    if (v.stale) return v;

    const state = vehicleStates.get(v.entityId);
    if (!state || state.speed < 0.5 || !state.shape) return v;

    const shape = state.shape;
    const total = shapeLength(shape);

    // Advance exactly 1s of movement
    const advance = state.speed * 1.0 * state.direction;
    let newDist = state.shapeDist + advance;
    newDist = Math.max(0, Math.min(newDist, total));

    // Update baseline for next beat
    state.shapeDist = newDist;

    // Sample position + bearing from shape
    const pos = sampleShape(shape, newDist);
    if (!pos) return v;

    const bearing = bearingAtDist(shape, newDist, state.direction);

    return {
      ...v,
      latitude: pos.lat,
      longitude: pos.lon,
      bearing,
      shapeDistTraveled: newDist,
    };
  });
}
