import type { VehiclePosition, ShapePolyline } from "../types.js";
import { config } from "../config.js";
import {
  haversineDistance,
  calculateBearing,
  projectForward as projectForwardFallback,
} from "./geo.js";
import {
  getShapeForTrip,
  getShapeForRoute,
  snapToShape,
  sampleShape,
  shapeLength,
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

      v.bearing = bearingAtShapeDist(shape, snapDist);
    } else {
      v.shapeDistTraveled = -1;
      v.shapeId = "";
    }

    if (prev) {
      const dt = v.timestamp - prev.targetTimestamp;

      if (dt > 0) {
        // Calculate speed
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

        // Infer bearing for no-shape vehicles
        if (!shape && v.bearing === 0 && dist > 5) {
          v.bearing = calculateBearing(
            prev.targetLat,
            prev.targetLon,
            v.latitude,
            v.longitude
          );
        }
      } else {
        v.speed = prev.speed;
        if (v.bearing === 0) v.bearing = prev.bearing;
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
        travelTimeMs: Math.max(
          (v.timestamp - prev.targetTimestamp) * 1000,
          config.pollIntervalMs
        ),
      });
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
 * Interpolate all vehicle positions for the current moment.
 *
 * For each vehicle:
 *  1. Calculate how far through the origin→target journey we are (t = 0..1)
 *  2. If t < 1: interpolate along the shape between origin and target
 *  3. If t >= 1: project forward past the target using speed + shape
 *
 * This fills the gap between two poll positions smoothly along the
 * actual road/track, instead of teleporting.
 */
export function interpolate(
  vehicles: VehiclePosition[],
  _deltaMs: number
): VehiclePosition[] {
  const nowMs = Date.now();

  return vehicles.map((v) => {
    if (v.stale) return v;

    const state = vehicleStates.get(v.entityId);
    if (!state || state.speed < 0.5) return v;

    // How far through the origin→target journey are we? (0 to 1+)
    const elapsed = nowMs - state.targetReceivedAt;
    const t = elapsed / state.travelTimeMs;

    const shape = state.shapeId
      ? (getShapeForTrip(v.tripId) ?? getShapeForRoute(v.routeId))
      : undefined;

    // ── Shape-following interpolation ──
    if (
      shape &&
      shape.length >= 2 &&
      state.originShapeDist >= 0 &&
      state.targetShapeDist >= 0
    ) {
      const total = shapeLength(shape);
      let dist: number;

      if (t <= 1) {
        // Still catching up to the target — lerp along shape
        dist =
          state.originShapeDist +
          t * (state.targetShapeDist - state.originShapeDist);
      } else {
        // Past the target — project forward from target
        const overshootSec = ((t - 1) * state.travelTimeMs) / 1000;
        dist = state.targetShapeDist + state.speed * overshootSec;
      }

      dist = Math.max(0, Math.min(dist, total));
      const pos = sampleShape(shape, dist);

      if (pos) {
        return {
          ...v,
          latitude: pos.lat,
          longitude: pos.lon,
          shapeDistTraveled: dist,
          bearing: bearingAtShapeDist(shape, dist),
        };
      }
    }

    // ── Straight-line fallback ──
    if (state.bearing === 0) return v;

    if (t <= 1) {
      // Lerp between origin and target
      return {
        ...v,
        latitude:
          state.originLat + t * (state.targetLat - state.originLat),
        longitude:
          state.originLon + t * (state.targetLon - state.originLon),
      };
    } else {
      // Project forward past target
      const overshootSec = ((t - 1) * state.travelTimeMs) / 1000;
      const advanceM = state.speed * overshootSec;
      const [newLat, newLon] = projectForwardFallback(
        state.targetLat,
        state.targetLon,
        state.bearing,
        advanceM
      );
      return { ...v, latitude: newLat, longitude: newLon };
    }
  });
}

// ── Helpers ──

function bearingAtShapeDist(shape: ShapePolyline, dist: number): number {
  if (shape.length < 2) return 0;

  for (let i = 0; i < shape.length - 1; i++) {
    const a = shape[i]!;
    const b = shape[i + 1]!;
    if (dist >= a.dist && dist <= b.dist) {
      return calculateBearing(a.lat, a.lon, b.lat, b.lon);
    }
  }

  const a = shape[shape.length - 2]!;
  const b = shape[shape.length - 1]!;
  return calculateBearing(a.lat, a.lon, b.lat, b.lon);
}
