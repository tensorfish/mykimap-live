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

interface CachedShape {
  path: Array<[number, number]>;
  dists: number[];
  totalDist: number;
}

const shapeCache = new Map<string, CachedShape | null>();
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
    if (data.path?.length >= 2 && data.dists) {
      shapeCache.set(key, {
        path: data.path,
        dists: data.dists,
        totalDist: data.dists[data.dists.length - 1] || 0,
      });
    } else {
      shapeCache.set(key, null);
    }
  } catch { shapeCache.set(key, null); }
  finally { shapeFetching.delete(key); }
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

function sliceShape(shape: CachedShape, fromDist: number, toDist: number): Array<[number, number]> {
  const { path, dists, totalDist } = shape;
  const lo = Math.max(0, Math.min(fromDist, toDist));
  const hi = Math.min(totalDist, Math.max(fromDist, toDist));
  const result: Array<[number, number]> = [];
  const startPos = sampleShapeAtDist(shape, lo);
  if (startPos) result.push(startPos);
  for (let i = 0; i < path.length; i++) {
    if (dists[i]! > lo && dists[i]! < hi) result.push(path[i]!);
  }
  const endPos = sampleShapeAtDist(shape, hi);
  if (endPos) result.push(endPos);
  if (fromDist > toDist) result.reverse();
  return result;
}

function clientSnapToShape(v: VehiclePosition): number {
  if (v.shapeDistTraveled >= 0) return v.shapeDistTraveled;
  const shape = shapeCache.get(getShapeCacheKey(v));
  if (!shape || shape.path.length < 2) return -1;
  let bestDist = Infinity, bestShapeDist = 0;
  for (let i = 0; i < shape.path.length - 1; i++) {
    const a = shape.path[i]!, b = shape.path[i + 1]!;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((v.longitude - a[0]) * dx + (v.latitude - a[1]) * dy) / lenSq)) : 0;
    const projLon = a[0] + t * dx, projLat = a[1] + t * dy;
    const d = Math.sqrt((v.latitude - projLat) ** 2 + (v.longitude - projLon) ** 2);
    if (d < bestDist) {
      bestDist = d;
      bestShapeDist = shape.dists[i]! + t * (shape.dists[i + 1]! - shape.dists[i]!);
    }
  }
  return bestShapeDist;
}

// ── Animation state ──
//
// Simple model:
// - Each vehicle has a queue of target distances (from server updates)
// - currentDist advances toward the next target at a steady speed
// - When it reaches a target, it pops and moves toward the next one
// - When the queue is empty, the arrow stops and the trail fades
// - Trail = shape slice from tailDist to currentDist

const TRAIL_LENGTH_M = 800;
const TRAIL_FADE_SPEED = 3; // m/s when stopped
const ANIM_SPEED_MS = 15; // m/s default animation speed

interface VehicleAnim {
  currentDist: number;
  tailDist: number;
  /** Queue of target shapeDists to animate through */
  targets: number[];
  speed: number;
  direction: number;
  shapeKey: string;
}

const anims = new Map<string, VehicleAnim>();

// ── Feed data ──

export function feedBacklog(backlog: Array<{ vehicles: VehiclePosition[] }>): void {
  if (backlog.length === 0) return;

  // Build a queue of positions per vehicle from ALL backlog ticks.
  // The arrow starts at the oldest position and animates through each one.
  const vehicleHistory = new Map<string, { dists: number[]; v: VehiclePosition }>();

  for (const tick of backlog) {
    for (const v of tick.vehicles) {
      fetchAndCacheShape(v);
      const dist = clientSnapToShape(v);
      if (dist < 0) continue;

      let entry = vehicleHistory.get(v.entityId);
      if (!entry) {
        entry = { dists: [], v };
        vehicleHistory.set(v.entityId, entry);
      }
      // Only add if position actually changed
      const lastDist = entry.dists[entry.dists.length - 1];
      if (lastDist === undefined || Math.abs(dist - lastDist) > 0.5) {
        entry.dists.push(dist);
      }
      entry.v = v; // keep latest vehicle data
    }
  }

  // Create animation states: start at first position, queue the rest
  for (const [entityId, { dists, v }] of vehicleHistory) {
    if (dists.length === 0) continue;
    const startDist = dists[0]!;
    const targets = dists.slice(1); // everything after the starting position
    const dir = targets.length > 0 ? (targets[0]! >= startDist ? 1 : -1) : 1;

    anims.set(entityId, {
      currentDist: startDist,
      tailDist: startDist - (TRAIL_LENGTH_M * dir),
      targets,
      speed: ANIM_SPEED_MS,
      direction: dir,
      shapeKey: getShapeCacheKey(v),
    });
  }
}

export function feedTick(vehicles: VehiclePosition[]): void {
  const seen = new Set<string>();

  for (const v of vehicles) {
    seen.add(v.entityId);
    fetchAndCacheShape(v);
    const dist = clientSnapToShape(v);
    if (dist < 0) continue;

    const existing = anims.get(v.entityId);
    if (existing) {
      // Add new target to the queue
      const lastTarget = existing.targets[existing.targets.length - 1] ?? existing.currentDist;
      if (Math.abs(dist - lastTarget) > 0.5) {
        existing.targets.push(dist);
        // Update speed from distance between targets
        const totalQueueDist = Math.abs(dist - existing.currentDist);
        if (totalQueueDist > 1) {
          // Aim to cover the queue in ~1 second per target
          existing.speed = Math.max(ANIM_SPEED_MS, totalQueueDist / Math.max(1, existing.targets.length));
        }
      }
    } else {
      // New vehicle — place at this position, no targets yet
      anims.set(v.entityId, {
        currentDist: dist,
        tailDist: dist - TRAIL_LENGTH_M,
        targets: [],
        speed: ANIM_SPEED_MS,
        direction: 1,
        shapeKey: getShapeCacheKey(v),
      });
    }
  }

  for (const id of anims.keys()) {
    if (!seen.has(id)) anims.delete(id);
  }
}

// ── Compute frame ──

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

    if (!anim || !shape || v.stale) {
      return {
        entityId: v.entityId, mode: v.mode,
        position: [v.longitude, v.latitude] as [number, number],
        angle: -v.bearing, stale: v.stale, speed: v.speed,
        bearing: v.bearing, routeId: v.routeId,
        vehicleId: v.vehicleId, vehicleLabel: v.vehicleLabel,
      };
    }

    // Advance toward the next target in the queue
    if (anim.targets.length > 0) {
      const target = anim.targets[0]!;
      anim.direction = target >= anim.currentDist ? 1 : -1;
      const advance = anim.speed * (dtMs / 1000);

      if (anim.direction > 0) {
        anim.currentDist = Math.min(anim.currentDist + advance, target);
      } else {
        anim.currentDist = Math.max(anim.currentDist - advance, target);
      }

      // Reached target — pop it and move to next
      if (Math.abs(anim.currentDist - target) < 0.5) {
        anim.currentDist = target;
        anim.targets.shift();
      }
    }

    anim.currentDist = Math.max(0, Math.min(anim.currentDist, shape.totalDist));

    // Trail: follows while moving, fades when stopped
    const isMoving = anim.targets.length > 0;
    const idealTail = anim.currentDist - (TRAIL_LENGTH_M * anim.direction);

    if (anim.direction > 0) {
      if (isMoving && anim.tailDist < idealTail) {
        anim.tailDist += anim.speed * (dtMs / 1000);
        anim.tailDist = Math.min(anim.tailDist, idealTail);
      }
      if (!isMoving && anim.tailDist < anim.currentDist) {
        anim.tailDist += TRAIL_FADE_SPEED * (dtMs / 1000);
        anim.tailDist = Math.min(anim.tailDist, anim.currentDist);
      }
    } else {
      if (isMoving && anim.tailDist > idealTail) {
        anim.tailDist -= anim.speed * (dtMs / 1000);
        anim.tailDist = Math.max(anim.tailDist, idealTail);
      }
      if (!isMoving && anim.tailDist > anim.currentDist) {
        anim.tailDist -= TRAIL_FADE_SPEED * (dtMs / 1000);
        anim.tailDist = Math.max(anim.tailDist, anim.currentDist);
      }
    }
    anim.tailDist = Math.max(0, Math.min(anim.tailDist, shape.totalDist));

    // Sample position + bearing from shape
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

    // Bearing from movement direction on shape
    const lookBehind = 10;
    const behindDist = anim.currentDist - (lookBehind * anim.direction);
    const behindPos = sampleShapeAtDist(shape, Math.max(0, Math.min(behindDist, shape.totalDist)));
    let bearing = 0;
    if (behindPos && (Math.abs(pos[0] - behindPos[0]) > 1e-8 || Math.abs(pos[1] - behindPos[1]) > 1e-8)) {
      bearing = ((Math.atan2(pos[0] - behindPos[0], pos[1] - behindPos[1]) * 180 / Math.PI) + 360) % 360;
    }

    return {
      entityId: v.entityId, mode: v.mode,
      position: pos, angle: -bearing,
      stale: v.stale, speed: anim.speed,
      bearing, routeId: v.routeId,
      vehicleId: v.vehicleId, vehicleLabel: v.vehicleLabel,
    };
  });
}

// ── Layers ──

export function createVehicleLayer(display: DisplayVehicle[], selectedId: string | null) {
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
    sizeScale: 1, sizeUnits: "pixels" as const,
    sizeMinPixels: 8, sizeMaxPixels: 40,
    pickable: true, billboard: false,
  });
}

const TRAIL_WIDTH: Record<TransportMode, number> = { metro: 3, tram: 2.5, bus: 1.5, vline: 3 };

export function createTrailLayer(vehicles: VehiclePosition[], selectedId: string | null) {
  const hasSelection = selectedId !== null;
  const data: { entityId: string; path: Array<[number, number]>; mode: TransportMode }[] = [];

  for (const v of vehicles) {
    if (v.stale) continue;
    if (hasSelection && v.entityId !== selectedId) continue;
    const anim = anims.get(v.entityId);
    const shape = shapeCache.get(getShapeCacheKey(v));
    if (!anim || !shape) continue;
    const trailPath = sliceShape(shape, anim.tailDist, anim.currentDist);
    if (trailPath.length < 2) continue;
    data.push({ entityId: v.entityId, path: trailPath, mode: v.mode });
  }

  return new PathLayer({
    id: "trails", data,
    getPath: (d: any) => d.path,
    getColor: (d: any) => {
      const [r, g, b] = MODE_COLORS[d.mode as TransportMode];
      if (hasSelection && d.entityId === selectedId) return [r, g, b, 200];
      return [r, g, b, 100];
    },
    getWidth: (d: any) => {
      if (hasSelection && d.entityId === selectedId) return TRAIL_WIDTH[d.mode as TransportMode] * 2;
      return TRAIL_WIDTH[d.mode as TransportMode];
    },
    widthUnits: "pixels" as const, widthMinPixels: 1, widthMaxPixels: 8,
    capRounded: true, jointRounded: true, pickable: false,
  });
}

export function createRouteShapeLayer(routeShape: Array<[number, number]> | null, mode: TransportMode | null) {
  if (!routeShape || routeShape.length < 2 || !mode) return new PathLayer({ id: "route-shape", data: [] });
  const [r, g, b] = MODE_COLORS[mode];
  return new PathLayer({
    id: "route-shape",
    data: [{ path: routeShape }],
    getPath: (d: any) => d.path,
    getColor: [r, g, b, 60],
    getWidth: 4, widthUnits: "pixels" as const,
    widthMinPixels: 2, widthMaxPixels: 8,
    capRounded: true, jointRounded: true, pickable: false,
  });
}
