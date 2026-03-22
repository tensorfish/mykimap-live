import type { VehiclePosition, TransportMode } from "../types.js";
import { config } from "../config.js";
import { haversineDistance, calculateBearing } from "./geo.js";
import {
  getShapeForTrip,
  getShapeForRoute,
  snapToShape,
  sampleShape,
  shapeLength,
} from "../shapes/index.js";

// ── Per-vehicle state ──

interface VehicleState {
  /** Shape-snapped position from the last poll */
  lat: number;
  lon: number;
  shapeDist: number;
  timestamp: number;

  /** Calculated from consecutive polls */
  speed: number;      // m/s
  direction: number;  // +1 or -1 along shape
  bearing: number;    // degrees, derived from shape + direction

  /** Wall clock when this state was set */
  receivedAt: number;
}

const vehicleStates = new Map<string, VehicleState>();

// ── Trail history ──

const TRAIL_LENGTH: Record<TransportMode, number> = {
  metro: 30, vline: 30, tram: 60, bus: 80,
};

const vehicleTrails = new Map<string, Array<[number, number]>>();

function appendTrail(entityId: string, lon: number, lat: number, mode: TransportMode): void {
  let trail = vehicleTrails.get(entityId);
  if (!trail) {
    trail = [];
    vehicleTrails.set(entityId, trail);
  }
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

// ── Shape bearing helper ──

function bearingAtDist(
  shape: { lat: number; lon: number; dist: number }[],
  dist: number,
  direction: number
): number {
  if (shape.length < 2) return 0;

  // Find the segment containing this distance
  let a = shape[0]!, b = shape[1]!;
  for (let i = 0; i < shape.length - 1; i++) {
    if (dist >= shape[i]!.dist && dist <= shape[i + 1]!.dist) {
      a = shape[i]!;
      b = shape[i + 1]!;
      break;
    }
    // Past the end — use last segment
    a = shape[shape.length - 2]!;
    b = shape[shape.length - 1]!;
  }

  let bearing = calculateBearing(a.lat, a.lon, b.lat, b.lon);

  // If traveling backwards along the shape, flip bearing 180°
  if (direction < 0) {
    bearing = (bearing + 180) % 360;
  }

  return bearing;
}

// ── Process a fresh poll ──

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

    // Match to shape
    const shape = getShapeForTrip(v.tripId) ?? getShapeForRoute(v.routeId);
    let snapDist = -1;

    if (shape && shape.length >= 2) {
      snapDist = snapToShape(v.latitude, v.longitude, shape);
      v.shapeDistTraveled = snapDist;
      v.shapeId = v.tripId;

      const snapped = sampleShape(shape, snapDist);
      if (snapped) {
        v.latitude = snapped.lat;
        v.longitude = snapped.lon;
      }
    } else {
      v.shapeDistTraveled = -1;
      v.shapeId = "";
    }

    if (prev) {
      const dt = v.timestamp - prev.timestamp;

      if (dt > 0) {
        // New data — calculate speed and direction
        let dist: number;
        let direction = 1;

        if (snapDist >= 0 && prev.shapeDist >= 0) {
          const shapeDelta = snapDist - prev.shapeDist;
          dist = Math.abs(shapeDelta);
          direction = shapeDelta >= 0 ? 1 : -1;
        } else {
          dist = haversineDistance(prev.lat, prev.lon, v.latitude, v.longitude);
        }

        const maxSpeed = v.mode === "metro" || v.mode === "vline" ? 33.3 : 22.2;
        v.speed = Math.min(dist / dt, maxSpeed);

        // Bearing from shape direction + travel direction
        if (shape && snapDist >= 0) {
          v.bearing = bearingAtDist(shape, snapDist, direction);
        } else if (dist > 5) {
          v.bearing = calculateBearing(prev.lat, prev.lon, v.latitude, v.longitude);
        } else {
          v.bearing = prev.bearing;
        }

        vehicleStates.set(v.entityId, {
          lat: v.latitude,
          lon: v.longitude,
          shapeDist: snapDist,
          timestamp: v.timestamp,
          speed: v.speed,
          direction,
          bearing: v.bearing,
          receivedAt: nowMs,
        });
      } else {
        // Duplicate poll — carry forward
        v.speed = prev.speed;
        v.bearing = prev.bearing;
      }
    } else {
      // First sighting
      if (shape && snapDist >= 0) {
        v.bearing = bearingAtDist(shape, snapDist, 1);
      }

      vehicleStates.set(v.entityId, {
        lat: v.latitude,
        lon: v.longitude,
        shapeDist: snapDist,
        timestamp: v.timestamp,
        speed: 0,
        direction: 1,
        bearing: v.bearing,
        receivedAt: nowMs,
      });
    }
  }

  // Clean up departed
  const currentIds = new Set(vehicles.map((v) => v.entityId));
  for (const key of vehicleStates.keys()) {
    if (!currentIds.has(key)) vehicleStates.delete(key);
  }

  return vehicles;
}

// ── Interpolate for broadcast ──
//
// Advances each vehicle along its shape by speed × elapsed.
// Trail is appended from the shape-interpolated position, so
// the trail follows the road. Bearing is derived from shape
// direction at the interpolated point.

export function interpolate(vehicles: VehiclePosition[]): VehiclePosition[] {
  const nowMs = Date.now();

  // Clean departed trails
  const currentIds = new Set(vehicles.map((v) => v.entityId));
  for (const key of vehicleTrails.keys()) {
    if (!currentIds.has(key)) vehicleTrails.delete(key);
  }

  return vehicles.map((v) => {
    if (v.stale) return v;

    const state = vehicleStates.get(v.entityId);
    if (!state || state.speed < 0.5) return v;

    const shape = state.shapeDist >= 0
      ? (getShapeForTrip(v.tripId) ?? getShapeForRoute(v.routeId))
      : undefined;

    if (shape && shape.length >= 2) {
      // Advance along shape
      const elapsedSec = (nowMs - state.receivedAt) / 1000;
      const advanceM = state.speed * elapsedSec * state.direction;
      let newDist = state.shapeDist + advanceM;

      const total = shapeLength(shape);
      newDist = Math.max(0, Math.min(newDist, total));

      const pos = sampleShape(shape, newDist);
      if (pos) {
        const bearing = bearingAtDist(shape, newDist, state.direction);
        appendTrail(v.entityId, pos.lon, pos.lat, v.mode);
        return {
          ...v,
          latitude: pos.lat,
          longitude: pos.lon,
          bearing,
          shapeDistTraveled: newDist,
        };
      }
    }

    // Fallback: no shape — straight-line projection
    if (state.bearing === 0) return v;

    const elapsedSec = (nowMs - state.receivedAt) / 1000;
    const distM = state.speed * elapsedSec;
    const DEG = Math.PI / 180;
    const latOff = (distM * Math.cos(state.bearing * DEG)) / 111_000;
    const lonOff = (distM * Math.sin(state.bearing * DEG)) / (111_000 * Math.cos(state.lat * DEG));
    const newLat = state.lat + latOff;
    const newLon = state.lon + lonOff;

    appendTrail(v.entityId, newLon, newLat, v.mode);
    return { ...v, latitude: newLat, longitude: newLon };
  });
}
