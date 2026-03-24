import { IconLayer, PathLayer } from "@deck.gl/layers";
import type { VehiclePosition, TransportMode, SegmentSpeed } from "./types.js";
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

// Cache snap results + last matched segment index for search acceleration
const snapCache = new Map<string, { lat: number; lon: number; dist: number; segIdx: number }>();

/** Search radius around last known segment before falling back to full scan */
const SNAP_SEARCH_RADIUS = 30;

function snapToSegment(shape: CachedShape, i: number, lat: number, lon: number): { d: number; shapeDist: number } {
  const a = shape.path[i]!, b = shape.path[i + 1]!;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((lon - a[0]) * dx + (lat - a[1]) * dy) / lenSq)) : 0;
  const projLon = a[0] + t * dx, projLat = a[1] + t * dy;
  const d = Math.sqrt((lat - projLat) ** 2 + (lon - projLon) ** 2);
  return { d, shapeDist: shape.dists[i]! + t * (shape.dists[i + 1]! - shape.dists[i]!) };
}

function clientSnapToShape(v: VehiclePosition): number {
  if (v.shapeDistTraveled >= 0) return v.shapeDistTraveled;
  const shape = shapeCache.get(getShapeCacheKey(v));
  if (!shape || shape.path.length < 2) return -1;

  // Check cache — skip expensive scan if position hasn't changed
  const cached = snapCache.get(v.entityId);
  if (cached && Math.abs(cached.lat - v.latitude) < 1e-7 && Math.abs(cached.lon - v.longitude) < 1e-7) {
    return cached.dist;
  }

  const n = shape.path.length - 1;
  let bestDist = Infinity, bestShapeDist = 0, bestIdx = 0;

  // Try local search around the last matched segment first
  const lastIdx = cached?.segIdx ?? 0;
  const lo = Math.max(0, lastIdx - SNAP_SEARCH_RADIUS);
  const hi = Math.min(n, lastIdx + SNAP_SEARCH_RADIUS);

  for (let i = lo; i < hi; i++) {
    const { d, shapeDist } = snapToSegment(shape, i, v.latitude, v.longitude);
    if (d < bestDist) { bestDist = d; bestShapeDist = shapeDist; bestIdx = i; }
  }

  // If local search found a close match (< ~50m in degrees), use it.
  // Otherwise fall back to full scan.
  if (bestDist > SNAP_CLOSE_THRESHOLD) {
    for (let i = 0; i < n; i++) {
      if (i >= lo && i < hi) continue; // already searched
      const { d, shapeDist } = snapToSegment(shape, i, v.latitude, v.longitude);
      if (d < bestDist) { bestDist = d; bestShapeDist = shapeDist; bestIdx = i; }
    }
  }

  // Reject if the vehicle is too far from the route — it's off-track.
  // Only applies to buses. Trams, metro trains, and V/Line are on fixed
  // rail — always snap them regardless of GPS drift.
  if (bestDist > SNAP_MAX_DISTANCE && v.mode === "bus") {
    return -1;
  }

  snapCache.set(v.entityId, { lat: v.latitude, lon: v.longitude, dist: bestShapeDist, segIdx: bestIdx });
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
const TRAIL_FADE_SPEED = 30;       // m/s when stopped — 800m trail fades in ~27s
const ANIM_SPEED_MS = 15;          // m/s default animation speed
const MIN_MOVE_THRESHOLD_M = 0.5;  // min dist change to register as movement
const MIN_SPEED_DIST_M = 1;        // min dist change to compute speed
const SNAP_CLOSE_THRESHOLD = 0.0005; // ~50m in degrees — local snap result is good enough
const SNAP_MAX_DISTANCE = 0.003;    // ~300m in degrees — beyond this, vehicle is off-route
const TARGET_REACHED_M = 0.5;      // distance to consider target reached

// ── Congestion heatmap ──
//
// Each route shape is divided into segments (SEGMENT_LEN meters each).
// As vehicles move through segments, their speed is recorded.
// Segments are colored green → yellow → red by speed.
// Old readings decay so the heatmap reflects current conditions.

// ── Congestion heatmap ──
//
// On connect, the server sends a 10-min snapshot of per-segment speeds
// to seed the client. After that, the client accumulates locally from
// vehicle movements in feedTick.

const SEGMENT_LEN = 200; // must match server CONGESTION_SEGMENT_LEN
const HEATMAP_WINDOW_S = 600; // 10-minute sliding window
const HEATMAP_MAX_SAMPLES = 60; // ring buffer cap per segment

interface SpeedSample {
  ts: number;    // vehicle timestamp (POSIX seconds)
  speed: number; // m/s
}

interface RouteHeatmap {
  mode: TransportMode;
  segments: Map<number, SpeedSample[]>;
}

const heatmapData = new Map<string, RouteHeatmap>();
let heatmapDirty = true;
let cachedHeatmapLayer: PathLayer | null = null;
let cachedHeatmapTs = 0;

/** Mode baseline speeds (m/s) for color normalization */
const MODE_BASELINE_SPEED: Record<TransportMode, number> = {
  tram: 8.3,   // ~30 km/h
  metro: 22,   // ~80 km/h
  bus: 11,     // ~40 km/h
  vline: 28,   // ~100 km/h
};

/**
 * Seed heatmap from server-provided SegmentSpeed snapshot.
 * Called once on WebSocket init. Creates synthetic samples
 * so the client's sliding window has data immediately.
 */
export function seedHeatmap(congestion: SegmentSpeed[], nowTs: number): void {
  heatmapData.clear();
  heatmapDirty = true;
  for (const seg of congestion) {
    let route = heatmapData.get(seg.routeId);
    if (!route) {
      route = { mode: seg.mode, segments: new Map() };
      heatmapData.set(seg.routeId, route);
    }
    // Spread the server's sample count across the window as synthetic samples
    // so the sliding window average matches the server's value
    const samples: SpeedSample[] = [];
    const interval = HEATMAP_WINDOW_S / Math.max(seg.sampleCount, 1);
    for (let i = 0; i < seg.sampleCount; i++) {
      samples.push({ ts: nowTs - HEATMAP_WINDOW_S + i * interval, speed: seg.avgSpeed });
    }
    route.segments.set(seg.segIdx, samples);
  }
}

/**
 * Record a speed observation across ALL segments between prevDist and dist.
 * This fills the gaps — a vehicle traveling 250m in 30s crosses multiple
 * 200m segments, and all of them should get the speed reading.
 */
function recordSegmentSpeed(routeId: string, mode: TransportMode, prevDist: number, dist: number, speed: number, vehicleTs: number): void {
  let route = heatmapData.get(routeId);
  if (!route) {
    route = { mode, segments: new Map() };
    heatmapData.set(routeId, route);
  }
  const fromSeg = Math.max(0, Math.floor(Math.min(prevDist, dist) / SEGMENT_LEN));
  const toSeg = Math.max(0, Math.floor(Math.max(prevDist, dist) / SEGMENT_LEN));

  for (let seg = fromSeg; seg <= toSeg; seg++) {
    let buf = route.segments.get(seg);
    if (!buf) {
      buf = [];
      route.segments.set(seg, buf);
    }
    if (buf.length > 0 && buf[buf.length - 1]!.ts === vehicleTs) continue;
    buf.push({ ts: vehicleTs, speed });
    if (buf.length > HEATMAP_MAX_SAMPLES) buf.shift();
  }
  heatmapDirty = true;
}

/** Get average speed for a segment within the sliding window */
function segmentAvgSpeed(samples: SpeedSample[], cutoff: number): { avg: number; count: number } {
  let sum = 0, count = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i]!.ts < cutoff) break;
    sum += samples[i]!.speed;
    count++;
  }
  return { avg: count > 0 ? sum / count : NaN, count };
}

/**
 * Heatmap-only position tracker — separate from animation state.
 * Used by buildHeatmapForTime in playback to replay snapshots
 * without polluting the animation queue.
 */
const heatmapTracker = new Map<string, { dist: number; ts: number }>();

export function clearHeatmapTracker(): void {
  heatmapTracker.clear();
}

/**
 * Record heatmap data from vehicles WITHOUT touching animation state.
 * Maintains its own per-vehicle position tracker for speed calculation.
 */
export function recordHeatmapOnly(vehicles: VehiclePosition[]): void {
  for (const v of vehicles) {
    fetchAndCacheShape(v);
    const dist = clientSnapToShape(v);
    if (dist < 0) continue;

    const key = getShapeCacheKey(v);
    const prev = heatmapTracker.get(v.entityId);

    if (prev) {
      const moveDist = Math.abs(dist - prev.dist);
      const dt = Math.abs(v.timestamp - prev.ts);

      if (v.timestamp !== prev.ts && dt > 0 && moveDist > MIN_SPEED_DIST_M) {
        const speed = moveDist / dt;
        recordSegmentSpeed(key, v.mode, prev.dist, dist, speed, v.timestamp);
      }
    }

    heatmapTracker.set(v.entityId, { dist, ts: v.timestamp });
  }
}

/** Speed ratio (0–1) to RGB color: red → yellow → green */
function speedToColor(ratio: number): [number, number, number, number] {
  const r = Math.min(1, 2 - 2 * ratio);
  const g = Math.min(1, 2 * ratio);
  return [Math.floor(r * 255), Math.floor(g * 200), 30, 160];
}

interface VehicleAnim {
  currentDist: number;
  tailDist: number;
  targets: number[];
  speed: number;
  direction: number;
  shapeKey: string;
  lastTs: number; // vehicle timestamp from last feed
  lastHeatmapDist: number; // previous dist for heatmap segment fill
}

const anims = new Map<string, VehicleAnim>();

/** Clear all animation state (used when switching playback dates) */
/** Clear all animation and snap state. Called on playback date switch and seek. */
export function clearAnimations(): void {
  anims.clear();
  // NOTE: snapCache is intentionally preserved across seeks.
  // It caches entityId → shapeDist projections. Clearing it forces
  // expensive full-scan recomputation for ~3,500 vehicles.
  // The cache auto-updates when vehicle positions change.
}

// ── Feed data ──

/** Process WebSocket init backlog — build animation queues from historical ticks. */
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
      if (lastDist === undefined || Math.abs(dist - lastDist) > MIN_MOVE_THRESHOLD_M) {
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
      lastHeatmapDist: startDist,
    });
  }
}

/** Process a single tick of vehicle data — update animation targets and heatmap. */
export function feedTick(vehicles: VehiclePosition[]): void {
  const seen = new Set<string>();

  for (const v of vehicles) {
    seen.add(v.entityId);
    fetchAndCacheShape(v);
    const dist = clientSnapToShape(v);
    if (dist < 0) continue;

    const existing = anims.get(v.entityId);
    if (existing) {
      const lastTarget = existing.targets[existing.targets.length - 1] ?? existing.currentDist;
      const moveDist = Math.abs(dist - lastTarget);
      const snapDt = existing.lastTs > 0 ? Math.abs(v.timestamp - existing.lastTs) : 30;

      if (moveDist > MIN_MOVE_THRESHOLD_M) {
        existing.targets.push(dist);

        if (snapDt > 0 && moveDist > MIN_SPEED_DIST_M) {
          existing.speed = moveDist / snapDt;
        }
      }

      // Record into heatmap when vehicle timestamp changes (actual feed update).
      // Fill ALL segments between previous and current position.
      if (v.timestamp !== existing.lastTs && existing.lastTs > 0) {
        recordSegmentSpeed(getShapeCacheKey(v), v.mode, existing.lastHeatmapDist, dist, existing.speed, v.timestamp);
        existing.lastHeatmapDist = dist;
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
        lastHeatmapDist: dist,
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

/** Advance all vehicle animations by dtMs and return display-ready positions. */
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
      const newDirection = target >= anim.currentDist ? 1 : -1;

      // When direction flips, reset tail to current position.
      // Otherwise the trail ends up on the wrong side (appears "in the future").
      if (newDirection !== anim.direction) {
        anim.tailDist = anim.currentDist;
        anim.direction = newDirection;
      }

      const advance = anim.speed * (dtMs / 1000);

      if (anim.direction > 0) {
        anim.currentDist = Math.min(anim.currentDist + advance, target);
      } else {
        anim.currentDist = Math.max(anim.currentDist - advance, target);
      }

      if (Math.abs(anim.currentDist - target) < TARGET_REACHED_M) {
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

    // Bearing from movement direction on shape.
    // Sample two points — one behind and one ahead — and average the
    // bearing from each to the current position. This prevents flipping
    // at shape inflection points where a single lookBehind can invert.
    const LOOK_DIST = 50; // meters
    const clamp = (d: number) => Math.max(0, Math.min(d, shape.totalDist));
    const behindPos = sampleShapeAtDist(shape, clamp(anim.currentDist - LOOK_DIST * anim.direction));
    const aheadPos = sampleShapeAtDist(shape, clamp(anim.currentDist + LOOK_DIST * anim.direction));

    let bearing = 0;
    const bearings: number[] = [];
    if (behindPos && (Math.abs(pos[0] - behindPos[0]) > 1e-8 || Math.abs(pos[1] - behindPos[1]) > 1e-8)) {
      bearings.push(((Math.atan2(pos[0] - behindPos[0], pos[1] - behindPos[1]) * 180 / Math.PI) + 360) % 360);
    }
    if (aheadPos && (Math.abs(aheadPos[0] - pos[0]) > 1e-8 || Math.abs(aheadPos[1] - pos[1]) > 1e-8)) {
      bearings.push(((Math.atan2(aheadPos[0] - pos[0], aheadPos[1] - pos[1]) * 180 / Math.PI) + 360) % 360);
    }
    if (bearings.length > 0) {
      // Circular average to handle 0°/360° wraparound
      const sinSum = bearings.reduce((s, b) => s + Math.sin(b * Math.PI / 180), 0);
      const cosSum = bearings.reduce((s, b) => s + Math.cos(b * Math.PI / 180), 0);
      bearing = ((Math.atan2(sinSum, cosSum) * 180 / Math.PI) + 360) % 360;
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

/** Create the deck.gl IconLayer for vehicle arrows. */
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

/** Create the deck.gl PathLayer for vehicle snail trails. */
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

/**
 * Render congestion heatmap from locally accumulated speed data.
 * Seeded by server on connect, then maintained by feedTick.
 */
export function createHeatmapLayer(nowTs: number): PathLayer {
  // Return cached layer if data hasn't changed (avoid O(routes×segments) every frame)
  if (!heatmapDirty && cachedHeatmapLayer && nowTs === cachedHeatmapTs) {
    return cachedHeatmapLayer;
  }
  heatmapDirty = false;
  cachedHeatmapTs = nowTs;

  const cutoff = nowTs - HEATMAP_WINDOW_S;

  interface HeatSegment {
    path: Array<[number, number]>;
    color: [number, number, number, number];
  }

  const segments: HeatSegment[] = [];

  for (const [routeId, route] of heatmapData) {
    // Shape cache may be keyed by routeId or tripId — try both
    let shape = shapeCache.get(routeId);
    if (!shape) {
      // Scan for a cache entry whose key contains this routeId
      for (const [key, val] of shapeCache) {
        if (val && key.includes(routeId)) { shape = val; break; }
      }
    }
    if (!shape) continue;

    const baseline = MODE_BASELINE_SPEED[route.mode] ?? 10;

    for (const [segIdx, samples] of route.segments) {
      const { avg, count } = segmentAvgSpeed(samples, cutoff);
      if (isNaN(avg) || count < 2) continue;

      const ratio = Math.min(1, avg / baseline);
      const color = speedToColor(ratio);

      // Brighter with more samples (more confidence)
      const confidence = Math.min(1, count / 6);
      color[3] = Math.floor(80 + 100 * confidence);

      const fromDist = segIdx * SEGMENT_LEN;
      const toDist = Math.min((segIdx + 1) * SEGMENT_LEN, shape.totalDist);
      const path = sliceShape(shape, fromDist, toDist);
      if (path.length < 2) continue;

      segments.push({ path, color });
    }
  }

  cachedHeatmapLayer = new PathLayer({
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
  return cachedHeatmapLayer;
}

/** Create the deck.gl PathLayer for the selected vehicle's full route shape. */
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
