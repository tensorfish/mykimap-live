import { IconLayer, PathLayer } from "@deck.gl/layers";
import type { VehiclePosition, TransportMode } from "./types.js";
import { createArrowIconURL, ARROW_ICON_MAPPING } from "./icons.js";

// ── Colors ──

const MODE_COLORS: Record<TransportMode, [number, number, number]> = {
  metro: [52, 172, 225],
  tram: [120, 190, 32],
  bus: [255, 130, 0],
  vline: [165, 127, 178],
};

const STALE_COLOR: [number, number, number] = [100, 100, 100];
const DIMMED_COLOR: [number, number, number, number] = [80, 80, 80, 80];

const MODE_SIZE: Record<TransportMode, number> = {
  metro: 28, tram: 22, bus: 14, vline: 28,
};

let arrowIconUrl: string | null = null;
function getArrowIconUrl(): string {
  if (!arrowIconUrl) arrowIconUrl = createArrowIconURL(64);
  return arrowIconUrl;
}

// ── Route shape cache ──
// Each route's full shape is fetched once and cached.
// Vehicles animate along this shape using shapeDistTraveled (meters).

interface CachedShape {
  path: Array<[number, number]>;
  dists: number[]; // cumulative meters
  totalDist: number;
}

const shapeCache = new Map<string, CachedShape | null>(); // null = fetch in flight or failed
const shapeFetching = new Set<string>();

function getShapeCacheKey(v: VehiclePosition): string {
  return v.routeId || v.tripId;
}

async function fetchAndCacheShape(v: VehiclePosition): Promise<void> {
  const key = getShapeCacheKey(v);
  if (shapeCache.has(key) || shapeFetching.has(key)) return;

  shapeFetching.add(key);
  try {
    const url = `/api/route-shape/${encodeURIComponent(v.tripId)}?routeId=${encodeURIComponent(v.routeId)}`;
    const resp = await fetch(url);
    if (!resp.ok) { shapeCache.set(key, null); return; }
    const data = await resp.json();
    if (data.path && data.path.length >= 2 && data.dists) {
      shapeCache.set(key, {
        path: data.path,
        dists: data.dists,
        totalDist: data.dists[data.dists.length - 1] || 0,
      });
    } else {
      shapeCache.set(key, null);
    }
  } catch {
    shapeCache.set(key, null);
  } finally {
    shapeFetching.delete(key);
  }
}

function sampleShapeAtDist(shape: CachedShape, dist: number): [number, number] | null {
  const { path, dists, totalDist } = shape;
  if (path.length < 2) return null;

  const d = Math.max(0, Math.min(dist, totalDist));

  for (let i = 0; i < path.length - 1; i++) {
    if (d >= dists[i]! && d <= dists[i + 1]!) {
      const segLen = dists[i + 1]! - dists[i]!;
      const t = segLen > 0 ? (d - dists[i]!) / segLen : 0;
      return [
        path[i]![0] + t * (path[i + 1]![0] - path[i]![0]),
        path[i]![1] + t * (path[i + 1]![1] - path[i]![1]),
      ];
    }
  }
  return path[path.length - 1]!;
}

/** Extract shape points between two distances for the trail */
function sliceShape(shape: CachedShape, fromDist: number, toDist: number): Array<[number, number]> {
  const { path, dists, totalDist } = shape;
  const lo = Math.max(0, Math.min(fromDist, toDist));
  const hi = Math.max(0, Math.max(fromDist, toDist));
  const result: Array<[number, number]> = [];

  // Start point (interpolated)
  const startPos = sampleShapeAtDist(shape, lo);
  if (startPos) result.push(startPos);

  // All shape vertices between lo and hi
  for (let i = 0; i < path.length; i++) {
    if (dists[i]! > lo && dists[i]! < hi) {
      result.push(path[i]!);
    }
  }

  // End point (interpolated)
  const endPos = sampleShapeAtDist(shape, hi);
  if (endPos) result.push(endPos);

  // If traveling in reverse (fromDist > toDist), flip
  if (fromDist > toDist) result.reverse();

  return result;
}

// ── Per-vehicle animation state ──
// Each vehicle has a currentDist (where the arrow IS on the shape)
// and a targetDist (where it should be, from the server).
// Each frame, currentDist moves toward targetDist at the inferred speed.
// When it reaches targetDist, the arrow stops until the next update.

/** Trail length in meters behind the arrow */
const TRAIL_LENGTH_M = 800;

/** How long after the last update before the trail starts eating itself */
const TRAIL_EAT_DELAY_MS = 5000;

interface VehicleAnim {
  currentDist: number;
  targetDist: number;
  tailDist: number;
  speed: number;
  direction: number;
  shapeKey: string;
  lastUpdateAt: number;  // wall clock ms — when targetDist was last set
  lastSnapshotTs: number; // feed timestamp from last update (for speed calc)
}

const anims = new Map<string, VehicleAnim>();

// ── Process incoming ticks ──

/** How many seconds the initial catch-up animation should take */
const CATCHUP_SECONDS = 3;

export function feedBacklog(backlog: Array<{ vehicles: VehiclePosition[] }>): void {
  if (backlog.length === 0) return;

  // Process all ticks to build animation states (sets targetDist to latest)
  for (const tick of backlog) {
    feedTick(tick.vehicles, true);
  }

  // Use the FIRST tick as the starting position — this is the oldest
  // data in the backlog (~10s old). The arrow starts there and animates
  // toward the latest position over CATCHUP_SECONDS.
  // This gives visible movement the instant the page loads.
  const firstTick = backlog[0]!;
  const firstVehicles = new Map<string, VehiclePosition>();
  for (const v of firstTick.vehicles) firstVehicles.set(v.entityId, v);

  for (const [entityId, anim] of anims) {
    const firstV = firstVehicles.get(entityId);
    if (!firstV) continue;

    // Snap oldest position to shape (client-side snap for raw data)
    const startDist = clientSnapToShape(firstV);
    if (startDist >= 0 && Math.abs(anim.targetDist - startDist) > 1) {
      anim.currentDist = startDist;
      anim.speed = Math.abs(anim.targetDist - startDist) / CATCHUP_SECONDS;
      anim.direction = anim.targetDist >= startDist ? 1 : -1;
    }

    // Trail starts behind the arrow
    anim.tailDist = anim.currentDist - (TRAIL_LENGTH_M * anim.direction);
  }
}

/**
 * Client-side snap: if a vehicle has no shapeDistTraveled (raw playback data),
 * but we have its route shape cached, snap the lat/lon to the shape.
 */
function clientSnapToShape(v: VehiclePosition): number {
  if (v.shapeDistTraveled >= 0) return v.shapeDistTraveled;

  const shape = shapeCache.get(getShapeCacheKey(v));
  if (!shape || shape.path.length < 2) return -1;

  // Find the nearest point on the shape to the vehicle's lat/lon
  let bestDist = Infinity;
  let bestShapeDist = 0;

  for (let i = 0; i < shape.path.length - 1; i++) {
    const a = shape.path[i]!;
    const b = shape.path[i + 1]!;

    // Project point onto segment
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0
      ? Math.max(0, Math.min(1, ((v.longitude - a[0]) * dx + (v.latitude - a[1]) * dy) / lenSq))
      : 0;

    const projLon = a[0] + t * dx;
    const projLat = a[1] + t * dy;
    const d = Math.sqrt((v.latitude - projLat) ** 2 + (v.longitude - projLon) ** 2);

    if (d < bestDist) {
      bestDist = d;
      const segLen = shape.dists[i + 1]! - shape.dists[i]!;
      bestShapeDist = shape.dists[i]! + t * segLen;
    }
  }

  return bestShapeDist;
}

export function feedTick(vehicles: VehiclePosition[], isBacklog = false): void {
  const now = Date.now();
  const seen = new Set<string>();

  for (const v of vehicles) {
    seen.add(v.entityId);

    // Fetch route shape if not cached
    fetchAndCacheShape(v);

    // Client-side snap for playback data (shapeDistTraveled === -1)
    const shapeDist = clientSnapToShape(v);

    const shapeKey = getShapeCacheKey(v);
    const existing = anims.get(v.entityId);

    if (existing && shapeDist >= 0) {
      // Update target — vehicle moved to a new position on the shape
      const prevTarget = existing.targetDist;
      const newTarget = shapeDist;

      if (Math.abs(newTarget - prevTarget) > 0.5) {
        // Speed from snapshot timestamps (not wall clock — avoids
        // inflated speed during rapid playback)
        const prevTs = existing.lastSnapshotTs;
        const snapshotDt = prevTs > 0 ? Math.abs(v.timestamp - prevTs) : 0;
        const dt = snapshotDt > 0 ? snapshotDt : (now - existing.lastUpdateAt) / 1000;
        if (dt > 0) {
          existing.speed = Math.abs(newTarget - prevTarget) / dt;
        }
        existing.direction = newTarget >= prevTarget ? 1 : -1;
        existing.targetDist = newTarget;
        existing.lastUpdateAt = now;
        existing.lastSnapshotTs = v.timestamp;
      }
    } else if (!existing && shapeDist >= 0) {
      // New vehicle — start behind and animate forward
      const prevDist = v.prevShapeDistTraveled >= 0 ? v.prevShapeDistTraveled : shapeDist;
      const dist = Math.abs(shapeDist - prevDist);
      const inferredSpeed = v.speed > 0 ? v.speed : (dist > 0 ? dist / 30 : 0);

      const dir = shapeDist >= prevDist ? 1 : -1;
      anims.set(v.entityId, {
        currentDist: prevDist,
        targetDist: shapeDist,
        tailDist: prevDist - (TRAIL_LENGTH_M * dir),
        speed: inferredSpeed,
        direction: dir,
        shapeKey,
        lastUpdateAt: now,
        lastSnapshotTs: v.timestamp,
      });
    }
  }

  // Remove departed
  for (const id of anims.keys()) {
    if (!seen.has(id)) anims.delete(id);
  }
}

// ── Compute display positions for this frame ──

export interface DisplayVehicle {
  entityId: string;
  mode: TransportMode;
  position: [number, number];
  angle: number;
  stale: boolean;
  speed: number;
  bearing: number;
  routeId: string;
  vehicleId: string;
  vehicleLabel: string;
}

export function computeFrame(vehicles: VehiclePosition[], dtMs: number): DisplayVehicle[] {
  return vehicles.map((v) => {
    const anim = anims.get(v.entityId);
    const shape = shapeCache.get(getShapeCacheKey(v));

    // No shape or no animation state — render at server position
    if (!anim || !shape || v.stale) {
      return {
        entityId: v.entityId, mode: v.mode,
        position: [v.longitude, v.latitude] as [number, number],
        angle: -v.bearing, stale: v.stale, speed: v.speed,
        bearing: v.bearing, routeId: v.routeId,
        vehicleId: v.vehicleId, vehicleLabel: v.vehicleLabel,
      };
    }

    // Advance currentDist toward targetDist at inferred speed
    if (anim.speed > 0.5) {
      const remaining = anim.targetDist - anim.currentDist;
      const advance = anim.speed * (dtMs / 1000) * anim.direction;

      if (anim.direction > 0 && anim.currentDist < anim.targetDist) {
        anim.currentDist = Math.min(anim.currentDist + advance, anim.targetDist);
      } else if (anim.direction < 0 && anim.currentDist > anim.targetDist) {
        anim.currentDist = Math.max(anim.currentDist + advance, anim.targetDist);
      }
      // If reached target, stop (wait for next update)
    }

    // Clamp to shape bounds
    anim.currentDist = Math.max(0, Math.min(anim.currentDist, shape.totalDist));

    // Trail tail follows the arrow, maintaining TRAIL_LENGTH_M behind.
    // Only "eats itself" if no update for > 5 seconds (genuinely stopped).
    const idealTail = anim.currentDist - (TRAIL_LENGTH_M * anim.direction);
    const now = performance.now();
    const idleMs = now - anim.lastUpdateAt;
    const shouldEat = anim.currentDist === anim.targetDist && idleMs > TRAIL_EAT_DELAY_MS;

    if (anim.direction > 0) {
      if (anim.tailDist < idealTail) {
        anim.tailDist += anim.speed * (dtMs / 1000);
        anim.tailDist = Math.min(anim.tailDist, idealTail);
      }
      if (shouldEat && anim.tailDist < anim.currentDist) {
        anim.tailDist += anim.speed * (dtMs / 1000);
        anim.tailDist = Math.min(anim.tailDist, anim.currentDist);
      }
    } else {
      if (anim.tailDist > idealTail) {
        anim.tailDist -= anim.speed * (dtMs / 1000);
        anim.tailDist = Math.max(anim.tailDist, idealTail);
      }
      if (shouldEat && anim.tailDist > anim.currentDist) {
        anim.tailDist -= anim.speed * (dtMs / 1000);
        anim.tailDist = Math.max(anim.tailDist, anim.currentDist);
      }
    }
    anim.tailDist = Math.max(0, Math.min(anim.tailDist, shape.totalDist));

    // Sample position from the route shape
    const pos = sampleShapeAtDist(shape, anim.currentDist);
    if (!pos) {
      return {
        entityId: v.entityId, mode: v.mode,
        position: [v.longitude, v.latitude] as [number, number],
        angle: -v.bearing, stale: v.stale, speed: v.speed,
        bearing: v.bearing, routeId: v.routeId,
        vehicleId: v.vehicleId, vehicleLabel: v.vehicleLabel,
      };
    }

    // Bearing from actual movement: sample two nearby points on the shape
    // in the direction the arrow is traveling. This is always correct
    // regardless of whether the shape polyline runs forward or backward.
    const lookBehind = 10; // meters
    const behindDist = anim.currentDist - (lookBehind * anim.direction);
    const behindPos = sampleShapeAtDist(shape, Math.max(0, Math.min(behindDist, shape.totalDist)));
    let bearing = 0;
    if (behindPos && (Math.abs(pos[0] - behindPos[0]) > 1e-8 || Math.abs(pos[1] - behindPos[1]) > 1e-8)) {
      const dlon = pos[0] - behindPos[0];
      const dlat = pos[1] - behindPos[1];
      bearing = ((Math.atan2(dlon, dlat) * 180 / Math.PI) + 360) % 360;
    }

    return {
      entityId: v.entityId, mode: v.mode,
      position: pos,
      angle: -bearing,
      stale: v.stale,
      speed: anim.speed,
      bearing,
      routeId: v.routeId,
      vehicleId: v.vehicleId, vehicleLabel: v.vehicleLabel,
    };
  });
}

function bearingAtDist(shape: CachedShape, dist: number, direction: number): number {
  const { path, dists } = shape;
  if (path.length < 2) return 0;

  let a = path[0]!, b = path[1]!;
  for (let i = 0; i < path.length - 1; i++) {
    if (dist >= dists[i]! && dist <= dists[i + 1]!) {
      a = path[i]!; b = path[i + 1]!; break;
    }
  }
  if (dist > dists[dists.length - 1]!) {
    a = path[path.length - 2]!; b = path[path.length - 1]!;
  }

  const dlon = b[0] - a[0], dlat = b[1] - a[1];
  let bearing = ((Math.atan2(dlon, dlat) * 180 / Math.PI) + 360) % 360;
  if (direction < 0) bearing = (bearing + 180) % 360;
  return bearing;
}

// ── Vehicle arrow layer ──

export function createVehicleLayer(
  display: DisplayVehicle[],
  selectedId: string | null
) {
  const hasSelection = selectedId !== null;

  return new IconLayer<DisplayVehicle>({
    id: "vehicles",
    data: display,
    iconAtlas: getArrowIconUrl(),
    iconMapping: ARROW_ICON_MAPPING,
    getIcon: () => "arrow",
    getPosition: (d) => d.position,
    getColor: (d) => {
      if (hasSelection && d.entityId !== selectedId) return DIMMED_COLOR;
      if (d.stale) return [...STALE_COLOR, 160];
      return [...MODE_COLORS[d.mode], 230];
    },
    getSize: (d) => {
      if (hasSelection && d.entityId === selectedId) return MODE_SIZE[d.mode] * 1.4;
      return MODE_SIZE[d.mode];
    },
    getAngle: (d) => d.angle,
    sizeScale: 1,
    sizeUnits: "pixels" as const,
    sizeMinPixels: 8,
    sizeMaxPixels: 40,
    pickable: true,
    billboard: false,
  });
}

// ── Trail layer ──
// Trail = the portion of the route shape behind the arrow.
// Always on-route because it's sliced from the shape itself.

interface TrailData {
  entityId: string;
  path: Array<[number, number]>;
  mode: TransportMode;
}

const TRAIL_WIDTH: Record<TransportMode, number> = {
  metro: 3, tram: 2.5, bus: 1.5, vline: 3,
};

export function createTrailLayer(
  vehicles: VehiclePosition[],
  selectedId: string | null
) {
  const hasSelection = selectedId !== null;
  const data: TrailData[] = [];

  for (const v of vehicles) {
    if (v.stale) continue;
    if (hasSelection && v.entityId !== selectedId) continue;

    const anim = anims.get(v.entityId);
    const shape = shapeCache.get(getShapeCacheKey(v));
    if (!anim || !shape) continue;

    // Trail = shape from tailDist to currentDist.
    // Both are animated — tail follows the arrow, catches up when arrow stops.
    const trailPath = sliceShape(shape, anim.tailDist, anim.currentDist);
    if (trailPath.length < 2) continue;

    data.push({ entityId: v.entityId, path: trailPath, mode: v.mode });
  }

  return new PathLayer<TrailData>({
    id: "trails",
    data,
    getPath: (d) => d.path,
    getColor: (d) => {
      const [r, g, b] = MODE_COLORS[d.mode];
      if (hasSelection && d.entityId === selectedId) return [r, g, b, 200];
      return [r, g, b, 100];
    },
    getWidth: (d) => {
      if (hasSelection && d.entityId === selectedId) return TRAIL_WIDTH[d.mode] * 2;
      return TRAIL_WIDTH[d.mode];
    },
    widthUnits: "pixels" as const,
    widthMinPixels: 1,
    widthMaxPixels: 8,
    capRounded: true,
    jointRounded: true,
    pickable: false,
  });
}

// ── Full route shape layer (on vehicle selection) ──

export function createRouteShapeLayer(
  routeShape: Array<[number, number]> | null,
  mode: TransportMode | null
) {
  if (!routeShape || routeShape.length < 2 || !mode) {
    return new PathLayer({ id: "route-shape", data: [] });
  }
  const [r, g, b] = MODE_COLORS[mode];
  return new PathLayer({
    id: "route-shape",
    data: [{ path: routeShape }],
    getPath: (d: any) => d.path,
    getColor: [r, g, b, 60],
    getWidth: 4,
    widthUnits: "pixels" as const,
    widthMinPixels: 2,
    widthMaxPixels: 8,
    capRounded: true,
    jointRounded: true,
    pickable: false,
  });
}
