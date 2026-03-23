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
  } catch (error) {
    console.warn("[layers] Shape fetch failed for", key, error);
    shapeCache.set(key, null);
  }
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

// Cache snap results to avoid re-computing for the same lat/lon
const snapCache = new Map<string, { lat: number; lon: number; dist: number }>();

function clientSnapToShape(v: VehiclePosition): number {
  if (v.shapeDistTraveled >= 0) return v.shapeDistTraveled;
  const shape = shapeCache.get(getShapeCacheKey(v));
  if (!shape || shape.path.length < 2) return -1;

  // Check cache — skip expensive scan if position hasn't changed
  const cached = snapCache.get(v.entityId);
  if (cached && Math.abs(cached.lat - v.latitude) < 1e-7 && Math.abs(cached.lon - v.longitude) < 1e-7) {
    return cached.dist;
  }

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

  snapCache.set(v.entityId, { lat: v.latitude, lon: v.longitude, dist: bestShapeDist });
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
const TRAIL_FADE_SPEED = 30; // m/s when stopped — 800m trail fades in ~27s
const ANIM_SPEED_MS = 15; // m/s default animation speed

// ── Congestion heatmap ──
//
// Each route shape is divided into segments (SEGMENT_LEN meters each).
// As vehicles move through segments, their speed is recorded.
// Segments are colored green → yellow → red by speed.
// Old readings decay so the heatmap reflects current conditions.

const SEGMENT_LEN = 200; // meters per heatmap segment
const HEATMAP_DECAY = 0.15; // seconds — time constant for exponential decay
const HEATMAP_MAX_AGE = 120; // seconds — discard segments with no update in this long

/** Per-route heatmap data */
interface RouteHeatmap {
  /** Segment speeds in m/s (NaN = no data) */
  speeds: Float32Array;
  /** Last update time per segment (performance.now() in ms) */
  lastUpdate: Float32Array;
  segmentCount: number;
}

const heatmaps = new Map<string, RouteHeatmap>();

/** Mode baseline speeds (m/s) for color normalization */
const MODE_BASELINE_SPEED: Record<TransportMode, number> = {
  tram: 8.3,   // ~30 km/h
  metro: 22,   // ~80 km/h
  bus: 11,     // ~40 km/h
  vline: 28,   // ~100 km/h
};

function getOrCreateHeatmap(shapeKey: string): RouteHeatmap | null {
  const existing = heatmaps.get(shapeKey);
  if (existing) return existing;
  const shape = shapeCache.get(shapeKey);
  if (!shape || shape.totalDist < SEGMENT_LEN) return null;
  const segmentCount = Math.ceil(shape.totalDist / SEGMENT_LEN);
  const speeds = new Float32Array(segmentCount);
  speeds.fill(NaN);
  const lastUpdate = new Float32Array(segmentCount);
  const hm: RouteHeatmap = { speeds, lastUpdate, segmentCount };
  heatmaps.set(shapeKey, hm);
  return hm;
}

/** Record a vehicle's speed at its current position on the route */
function recordHeatmapSpeed(shapeKey: string, dist: number, speed: number, now: number): void {
  const hm = getOrCreateHeatmap(shapeKey);
  if (!hm) return;
  const segIdx = Math.min(Math.floor(dist / SEGMENT_LEN), hm.segmentCount - 1);
  if (segIdx < 0) return;

  const prev = hm.speeds[segIdx]!;
  if (isNaN(prev)) {
    hm.speeds[segIdx] = speed;
  } else {
    // Exponential moving average
    hm.speeds[segIdx] = prev * 0.7 + speed * 0.3;
  }
  hm.lastUpdate[segIdx] = now;
}

/** Speed ratio (0–1) to RGB color: red → yellow → green */
function speedToColor(ratio: number): [number, number, number, number] {
  // ratio: 0 = stopped, 1 = at or above baseline speed
  const r = Math.min(1, 2 - 2 * ratio);
  const g = Math.min(1, 2 * ratio);
  return [Math.floor(r * 255), Math.floor(g * 200), 30, 160];
}

export function clearHeatmaps(): void {
  heatmaps.clear();
}

interface VehicleAnim {
  currentDist: number;
  tailDist: number;
  targets: number[];
  speed: number;
  direction: number;
  shapeKey: string;
  lastTs: number; // vehicle timestamp from last feed
}

const anims = new Map<string, VehicleAnim>();

/** Clear all animation state (used when switching playback dates) */
export function clearAnimations(): void {
  anims.clear();
  snapCache.clear();
  heatmaps.clear();
}

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
      tailDist: startDist,
      targets,
      speed: ANIM_SPEED_MS,
      direction: dir,
      shapeKey: getShapeCacheKey(v),
      lastTs: 0,
    });
  }
}

export function feedTick(vehicles: VehiclePosition[]): void {
  const seen = new Set<string>();
  const now = performance.now();

  for (const v of vehicles) {
    seen.add(v.entityId);
    fetchAndCacheShape(v);
    const dist = clientSnapToShape(v);
    if (dist < 0) continue;

    const existing = anims.get(v.entityId);
    if (existing) {
      const lastTarget = existing.targets[existing.targets.length - 1] ?? existing.currentDist;
      if (Math.abs(dist - lastTarget) > 0.5) {
        existing.targets.push(dist);

        // Speed = distance to cover / time between this update and the last.
        // Use vehicle timestamps (not wall clock) for correct playback speed.
        // dtMs in computeFrame is already multiplied by speed multiplier,
        // so this speed should be in real m/s.
        const snapDt = existing.lastTs > 0 ? Math.abs(v.timestamp - existing.lastTs) : 30;
        const moveDist = Math.abs(dist - lastTarget);
        if (snapDt > 0 && moveDist > 1) {
          existing.speed = moveDist / snapDt;
        }

        // Record speed into heatmap
        recordHeatmapSpeed(existing.shapeKey, dist, existing.speed, now);
      }
      existing.lastTs = v.timestamp;
    } else {
      // New vehicle — place at this position, no targets yet
      anims.set(v.entityId, {
        currentDist: dist,
        tailDist: dist,
        targets: [],
        speed: ANIM_SPEED_MS,
        direction: 1,
        shapeKey: getShapeCacheKey(v),
        lastTs: v.timestamp,
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

    // Advance toward target at constant velocity.
    // When queue is empty, hold position (don't coast — coasting
    // overshoots and causes oscillation when the next target
    // arrives behind the arrow).
    if (anim.targets.length > 0) {
      const target = anim.targets[0]!;
      anim.direction = target >= anim.currentDist ? 1 : -1;
      const advance = anim.speed * (dtMs / 1000);

      if (anim.direction > 0) {
        anim.currentDist = Math.min(anim.currentDist + advance, target);
      } else {
        anim.currentDist = Math.max(anim.currentDist - advance, target);
      }

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

export function createHeatmapLayer(vehicles: VehiclePosition[]): PathLayer {
  const now = performance.now();
  const maxAgeMs = HEATMAP_MAX_AGE * 1000;

  // Collect the set of route shape keys visible on screen
  const seenKeys = new Set<string>();
  for (const v of vehicles) {
    seenKeys.add(getShapeCacheKey(v));
  }

  // Build per-vehicle mode lookup for baseline speed
  const keyToMode = new Map<string, TransportMode>();
  for (const v of vehicles) {
    const key = getShapeCacheKey(v);
    if (!keyToMode.has(key)) keyToMode.set(key, v.mode);
  }

  interface HeatSegment {
    path: Array<[number, number]>;
    color: [number, number, number, number];
  }

  const segments: HeatSegment[] = [];

  for (const key of seenKeys) {
    const shape = shapeCache.get(key);
    const hm = heatmaps.get(key);
    if (!shape || !hm) continue;

    const baseline = MODE_BASELINE_SPEED[keyToMode.get(key) ?? "tram"];

    for (let i = 0; i < hm.segmentCount; i++) {
      const speed = hm.speeds[i]!;
      const age = now - hm.lastUpdate[i]!;
      if (isNaN(speed) || age > maxAgeMs) continue;

      // Fade out old segments
      const ageFade = Math.max(0, 1 - age / maxAgeMs);
      const ratio = Math.min(1, speed / baseline);
      const color = speedToColor(ratio);
      color[3] = Math.floor(color[3]! * ageFade);
      if (color[3] < 10) continue;

      // Slice shape for this segment
      const fromDist = i * SEGMENT_LEN;
      const toDist = Math.min((i + 1) * SEGMENT_LEN, shape.totalDist);
      const path = sliceShape(shape, fromDist, toDist);
      if (path.length < 2) continue;

      segments.push({ path, color });
    }
  }

  return new PathLayer({
    id: "heatmap",
    data: segments,
    getPath: (d: HeatSegment) => d.path,
    getColor: (d: HeatSegment) => d.color,
    getWidth: 6,
    widthUnits: "pixels" as const,
    widthMinPixels: 3,
    widthMaxPixels: 10,
    capRounded: true,
    jointRounded: true,
    pickable: false,
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
