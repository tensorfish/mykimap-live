import type { VehiclePosition, ShapePolyline } from "../types.js";
import { config } from "../config.js";
import { haversineDistance, calculateBearing, projectForward as projectForwardFallback } from "./geo.js";
import {
  getShapeForTrip,
  snapToShape,
  sampleShape,
  shapeLength,
} from "../shapes/index.js";

/**
 * Previous snapshot, keyed by entityId.
 * Tracks the vehicle's last known position plus its distance
 * along the matched shape polyline.
 */
interface PreviousState {
  lat: number;
  lon: number;
  timestamp: number;
  bearing: number;
  speed: number;
  shapeDist: number;
  shapeId: string;
}

const previousPositions = new Map<string, PreviousState>();

/**
 * Process a new batch of vehicle positions from a poll.
 * - Snaps each vehicle onto its GTFS route shape
 * - Calculates speed from distance deltas along the shape
 * - Infers bearing for trams from the shape direction
 * - Marks stale vehicles
 */
export function processSnapshot(
  vehicles: VehiclePosition[],
  headerTimestamp: number
): VehiclePosition[] {
  const now = headerTimestamp || Math.floor(Date.now() / 1000);

  for (const v of vehicles) {
    const prev = previousPositions.get(v.entityId);
    const age = now - v.timestamp;

    v.stale = age * 1000 > config.staleVehicleThresholdMs;

    // Try to match vehicle to a shape polyline
    const shape = getShapeForTrip(v.tripId);

    if (shape && shape.length >= 2) {
      // Snap current position onto the shape
      const snapDist = snapToShape(v.latitude, v.longitude, shape);
      v.shapeDistTraveled = snapDist;
      v.shapeId = v.tripId; // We key by tripId for lookup

      // Place the vehicle exactly on the shape line
      const snapped = sampleShape(shape, snapDist);
      if (snapped) {
        v.latitude = snapped.lat;
        v.longitude = snapped.lon;
      }

      if (prev && prev.shapeDist >= 0) {
        const dt = v.timestamp - prev.timestamp;

        if (dt > 0) {
          // Calculate speed from distance traveled along the shape
          let distDelta = snapDist - prev.shapeDist;

          // Handle vehicles that might have wrapped around (end → start of shape)
          // or jumped due to shape mismatch — cap to reasonable distance
          if (distDelta < 0) {
            // Vehicle might be going the opposite direction on the shape,
            // or on a return trip. Use absolute value if small, else recalculate.
            distDelta = Math.abs(distDelta);
          }

          // Sanity check: cap speed at ~120 km/h for trains, ~80 km/h for others
          const maxSpeed = v.mode === "metro" || v.mode === "vline" ? 33.3 : 22.2;
          const calcSpeed = distDelta / dt;
          v.speed = Math.min(calcSpeed, maxSpeed);

          // Derive bearing from the shape direction at this point
          v.bearing = bearingAtShapeDist(shape, snapDist);
        }
      } else if (prev) {
        // First time we got a shape match — compute speed from haversine as before
        const dt = v.timestamp - prev.timestamp;
        if (dt > 0) {
          const dist = haversineDistance(prev.lat, prev.lon, v.latitude, v.longitude);
          v.speed = dist / dt;
        }
        v.bearing = bearingAtShapeDist(shape, snapDist);
      }
    } else {
      // No shape available — fall back to straight-line calc
      v.shapeDistTraveled = -1;
      v.shapeId = "";

      if (prev) {
        const dt = v.timestamp - prev.timestamp;

        if (dt > 0) {
          const dist = haversineDistance(prev.lat, prev.lon, v.latitude, v.longitude);
          v.speed = dist / dt;

          if (v.bearing === 0 && dist > 5) {
            v.bearing = calculateBearing(prev.lat, prev.lon, v.latitude, v.longitude);
          }
        } else {
          v.speed = prev.speed;
          if (v.bearing === 0) v.bearing = prev.bearing;
        }
      }
    }

    // Store for next diff
    previousPositions.set(v.entityId, {
      lat: v.latitude,
      lon: v.longitude,
      timestamp: v.timestamp,
      bearing: v.bearing,
      speed: v.speed,
      shapeDist: v.shapeDistTraveled,
      shapeId: v.shapeId,
    });
  }

  // Remove entities no longer in the feed
  const currentIds = new Set(vehicles.map((v) => v.entityId));
  for (const key of previousPositions.keys()) {
    if (!currentIds.has(key)) {
      previousPositions.delete(key);
    }
  }

  return vehicles;
}

/**
 * Interpolate all vehicle positions forward by `deltaMs` milliseconds.
 *
 * For shape-matched vehicles: advance along the polyline.
 * For unmatched vehicles: project forward by bearing (old behavior).
 * Stale and stationary vehicles are not moved.
 */
export function interpolate(
  vehicles: VehiclePosition[],
  deltaMs: number
): VehiclePosition[] {
  const deltaSec = deltaMs / 1000;

  return vehicles.map((v) => {
    if (v.stale || v.speed < 0.5) return v;

    const advanceM = v.speed * deltaSec;

    // Shape-following interpolation
    if (v.shapeDistTraveled >= 0 && v.shapeId) {
      const shape = getShapeForTrip(v.tripId);

      if (shape && shape.length >= 2) {
        const newDist = v.shapeDistTraveled + advanceM;
        const total = shapeLength(shape);

        // Clamp to shape — don't overshoot past the terminus
        const clampedDist = Math.min(newDist, total);
        const pos = sampleShape(shape, clampedDist);

        if (pos) {
          return {
            ...v,
            latitude: pos.lat,
            longitude: pos.lon,
            shapeDistTraveled: clampedDist,
            bearing: bearingAtShapeDist(shape, clampedDist),
          };
        }
      }
    }

    // Fallback: straight-line projection (no shape data)
    if (v.bearing === 0) return v;

    const [newLat, newLon] = projectForwardFallback(v.latitude, v.longitude, v.bearing, advanceM);

    return {
      ...v,
      latitude: newLat,
      longitude: newLon,
    };
  });
}

/**
 * Get the bearing (direction of travel) at a given distance along a shape.
 * Looks at the shape segment containing that distance.
 */
function bearingAtShapeDist(shape: ShapePolyline, dist: number): number {
  if (shape.length < 2) return 0;

  // Find the segment
  for (let i = 0; i < shape.length - 1; i++) {
    const a = shape[i]!;
    const b = shape[i + 1]!;

    if (dist >= a.dist && dist <= b.dist) {
      return calculateBearing(a.lat, a.lon, b.lat, b.lon);
    }
  }

  // Past the end — use last segment
  const a = shape[shape.length - 2]!;
  const b = shape[shape.length - 1]!;
  return calculateBearing(a.lat, a.lon, b.lat, b.lon);
}
