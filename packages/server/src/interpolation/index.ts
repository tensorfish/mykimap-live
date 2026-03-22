import type { VehiclePosition } from "../types.js";
import { config } from "../config.js";
import {
  haversineDistance,
  calculateBearing,
} from "./geo.js";
import {
  getShapeForTrip,
  getShapeForRoute,
  snapToShape,
  sampleShape,
} from "../shapes/index.js";

// ── Per-vehicle tracking state ──

interface VehicleState {
  /** Position from the most recent poll (the "target") */
  targetLat: number;
  targetLon: number;
  targetShapeDist: number;
  targetTimestamp: number;

  /** Position from the poll before that (the "origin") */
  originLat: number;
  originLon: number;
  originShapeDist: number;
  originTimestamp: number;

  /** Calculated values */
  bearing: number;
  speed: number;
  shapeId: string;

  /** When the target was received (wall clock ms) */
  targetReceivedAt: number;

  /** Estimated travel time between origin and target (ms) */
  travelTimeMs: number;
}

const vehicleStates = new Map<string, VehicleState>();

// ── Server-side trail history ──

/**
 * Trail length per mode (in points, at ~1 point/tick).
 * Buses and trams travel slower so a longer trail covers a similar
 * visual distance on the map as a shorter train trail.
 */
const TRAIL_LENGTH: Record<TransportMode, number> = {
  metro: 30,
  vline: 30,
  tram: 60,
  bus: 80,
};

/** Per-vehicle trail: entityId → array of [lon, lat] (most recent last) */
const vehicleTrails = new Map<string, Array<[number, number]>>();

/**
 * Append a position to a vehicle's trail. Deduplicates consecutive identical points.
 */
function appendTrail(entityId: string, lon: number, lat: number, mode: TransportMode): void {
  let trail = vehicleTrails.get(entityId);
  if (!trail) {
    trail = [];
    vehicleTrails.set(entityId, trail);
  }
  const last = trail[trail.length - 1];
  if (!last || Math.abs(last[0] - lon) > 1e-7 || Math.abs(last[1] - lat) > 1e-7) {
    const max = TRAIL_LENGTH[mode];
    trail.push([lon, lat]);
    if (trail.length > max) {
      trail.splice(0, trail.length - max);
    }
  }
}

/** Get all trails as a plain object for serialization */
export function getTrails(): Record<string, Array<[number, number]>> {
  const result: Record<string, Array<[number, number]>> = {};
  for (const [id, trail] of vehicleTrails) {
    if (trail.length >= 2) {
      result[id] = trail;
    }
  }
  return result;
}

/**
 * Process a new batch of vehicle positions from a poll.
 *
 * For each vehicle, the current position becomes the new "target"
 * and the previous target becomes the "origin". Between broadcasts,
 * vehicles are interpolated from origin → target along the shape,
 * then projected forward past the target using calculated speed.
 *
 * This means the vehicle smoothly traverses the gap between two
 * known positions along the road/track — no teleporting.
 */
export function processSnapshot(
  vehicles: VehiclePosition[],
  headerTimestamp: number
): VehiclePosition[] {
  const now = headerTimestamp || Math.floor(Date.now() / 1000);
  const nowMs = Date.now();

  for (const v of vehicles) {
    const prev = vehicleStates.get(v.entityId);
    const age = now - v.timestamp;

    v.stale = age * 1000 > config.staleVehicleThresholdMs;

    // Try to match vehicle to a shape polyline
    // Primary: trip_id match. Fallback: route_id match (trams need this).
    const shape = getShapeForTrip(v.tripId) ?? getShapeForRoute(v.routeId);
    let snapDist = -1;

    if (shape && shape.length >= 2) {
      snapDist = snapToShape(v.latitude, v.longitude, shape);
      v.shapeDistTraveled = snapDist;
      v.shapeId = v.tripId;

      // Snap the reported position onto the shape
      const snapped = sampleShape(shape, snapDist);
      if (snapped) {
        v.latitude = snapped.lat;
        v.longitude = snapped.lon;
      }
    } else {
      v.shapeDistTraveled = -1;
      v.shapeId = "";
    }

    // Append snapped position to trail (only from real poll data, not interpolation)
    if (!v.stale) {
      appendTrail(v.entityId, v.longitude, v.latitude, v.mode);
    }

    if (prev) {
      const dt = v.timestamp - prev.targetTimestamp;

      if (dt > 0) {
        // Vehicle timestamp changed — new data from the feed.
        // Calculate speed from position delta.
        let dist: number;
        if (snapDist >= 0 && prev.targetShapeDist >= 0) {
          dist = Math.abs(snapDist - prev.targetShapeDist);
        } else {
          dist = haversineDistance(
            prev.targetLat,
            prev.targetLon,
            v.latitude,
            v.longitude
          );
        }

        const maxSpeed =
          v.mode === "metro" || v.mode === "vline" ? 33.3 : 22.2;
        v.speed = Math.min(dist / dt, maxSpeed);

        // Compute bearing from consecutive poll positions.
        // This is ground truth — works regardless of shape direction.
        // Only update if vehicle moved enough (>5m) to give a reliable bearing.
        if (dist > 5) {
          v.bearing = calculateBearing(
            prev.targetLat,
            prev.targetLon,
            v.latitude,
            v.longitude
          );
        } else if (prev.bearing > 0) {
          v.bearing = prev.bearing; // Carry forward if stationary
        }

        // Promote: previous target becomes origin, new position becomes target
        vehicleStates.set(v.entityId, {
          originLat: prev.targetLat,
          originLon: prev.targetLon,
          originShapeDist: prev.targetShapeDist,
          originTimestamp: prev.targetTimestamp,

          targetLat: v.latitude,
          targetLon: v.longitude,
          targetShapeDist: snapDist,
          targetTimestamp: v.timestamp,

          bearing: v.bearing,
          speed: v.speed,
          shapeId: v.shapeId,
          targetReceivedAt: nowMs,
          travelTimeMs: Math.max(dt * 1000, config.pollIntervalMs),
        });
      } else {
        // Same timestamp — feed cache returned identical data.
        // Carry forward speed/bearing but do NOT reset targetReceivedAt.
        // This lets the interpolation engine keep projecting forward
        // past the target using the last known speed.
        v.speed = prev.speed;
        v.bearing = prev.bearing; // Always carry forward on duplicate
        // Don't update vehicleStates — keep the existing origin/target/receivedAt
      }
    } else {
      // First sighting — no origin yet, can't interpolate
      vehicleStates.set(v.entityId, {
        originLat: v.latitude,
        originLon: v.longitude,
        originShapeDist: snapDist,
        originTimestamp: v.timestamp,

        targetLat: v.latitude,
        targetLon: v.longitude,
        targetShapeDist: snapDist,
        targetTimestamp: v.timestamp,

        bearing: v.bearing,
        speed: 0,
        shapeId: v.shapeId,
        targetReceivedAt: nowMs,
        travelTimeMs: config.pollIntervalMs,
      });
    }
  }

  // Clean up departed vehicles
  const currentIds = new Set(vehicles.map((v) => v.entityId));
  for (const key of vehicleStates.keys()) {
    if (!currentIds.has(key)) {
      vehicleStates.delete(key);
    }
  }

  return vehicles;
}

/**
 * Clean up trails for vehicles no longer in the feed.
 * Called during broadcast cycle.
 */
export function cleanupTrails(vehicles: VehiclePosition[]): void {
  const currentIds = new Set(vehicles.map((v) => v.entityId));
  for (const key of vehicleTrails.keys()) {
    if (!currentIds.has(key)) vehicleTrails.delete(key);
  }
}
