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

// ── Trail config ──

const TRAIL_MAX: Record<TransportMode, number> = {
  metro: 300, vline: 300, tram: 600, bus: 800,
};

// ── Path queue per vehicle ──
//
// The trail IS the consumed portion of the path queue.
// As the playhead advances past queue points, those points move
// into the trail. Since queue points come from pathSegment (which
// is sampled from the GTFS shape polyline), the trail follows
// every curve of the route. No straight-line cutting.

interface VehicleQueue {
  /** Upcoming waypoints (ahead of playhead) */
  points: Array<[number, number]>;
  dists: number[];
  totalDist: number;
  playhead: number;
  speed: number; // degrees-per-ms
  lastAppendAt: number;
  /** Trail: route points the playhead has already passed */
  trail: Array<[number, number]>;
  mode: TransportMode;
}

const queues = new Map<string, VehicleQueue>();

function degDist(a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function appendToQueue(q: VehicleQueue, segment: Array<[number, number]>): void {
  for (const pt of segment) {
    const last = q.points[q.points.length - 1];
    if (last) {
      const d = degDist(last, pt);
      if (d < 1e-9) continue;
      q.totalDist += d;
    }
    q.points.push(pt);
    q.dists.push(q.totalDist);
  }
}

function sampleQueue(q: VehicleQueue): [number, number] {
  if (q.points.length === 0) return [0, 0];
  if (q.points.length === 1) return q.points[0]!;

  const d = Math.max(q.dists[0]!, Math.min(q.playhead, q.totalDist));

  for (let i = 0; i < q.points.length - 1; i++) {
    if (d >= q.dists[i]! && d <= q.dists[i + 1]!) {
      const segLen = q.dists[i + 1]! - q.dists[i]!;
      const t = segLen > 0 ? (d - q.dists[i]!) / segLen : 0;
      return [
        q.points[i]![0] + t * (q.points[i + 1]![0] - q.points[i]![0]),
        q.points[i]![1] + t * (q.points[i + 1]![1] - q.points[i]![1]),
      ];
    }
  }
  return q.points[q.points.length - 1]!;
}

/**
 * Advance playhead and move consumed queue points into the trail.
 * The trail is built from actual route geometry points, not sampled
 * playhead positions — so it follows every curve.
 */
function advanceAndTrail(q: VehicleQueue, dtMs: number): [number, number] {
  const ahead = q.totalDist - q.playhead;
  if (ahead > 0 && q.speed > 0) {
    q.playhead += q.speed * dtMs;
    q.playhead = Math.min(q.playhead, q.totalDist);
  }

  // Move queue points that the playhead has passed INTO the trail.
  // These points are from the pathSegment = actual route geometry.
  const max = TRAIL_MAX[q.mode];
  while (q.points.length > 1 && q.dists[1]! <= q.playhead) {
    const consumed = q.points.shift()!;
    q.dists.shift();

    // Append to trail (deduplicate)
    const last = q.trail[q.trail.length - 1];
    if (!last || Math.abs(last[0] - consumed[0]) > 1e-9 || Math.abs(last[1] - consumed[1]) > 1e-9) {
      q.trail.push(consumed);
      if (q.trail.length > max) q.trail.shift();
    }
  }

  // Current position (between two remaining queue points)
  const pos = sampleQueue(q);

  // Also add current interpolated position to trail tip
  // (so the trail reaches right up to the arrow)
  const lastTrail = q.trail[q.trail.length - 1];
  if (lastTrail && (Math.abs(lastTrail[0] - pos[0]) > 1e-8 || Math.abs(lastTrail[1] - pos[1]) > 1e-8)) {
    // Replace the last trail point with current position (live tip)
    // We'll add a "live tip" that gets overwritten each frame
    if (q.trail.length > 0 && (q.trail as any)._hasTip) {
      q.trail[q.trail.length - 1] = [pos[0], pos[1]];
    } else {
      q.trail.push([pos[0], pos[1]]);
      (q.trail as any)._hasTip = true;
      if (q.trail.length > max) q.trail.shift();
    }
  }

  return pos;
}

/**
 * Compute arrow bearing from the last two trail points.
 * This is the actual direction the arrow just moved — always correct
 * regardless of shape direction or server bearing computation.
 */
function bearingFromTrail(q: VehicleQueue): number {
  if (q.trail.length < 2) return 0;
  const a = q.trail[q.trail.length - 2]!;
  const b = q.trail[q.trail.length - 1]!;
  const dlon = b[0] - a[0];
  const dlat = b[1] - a[1];
  if (Math.abs(dlon) < 1e-9 && Math.abs(dlat) < 1e-9) return 0;
  // atan2(dlon, dlat) gives bearing from north, clockwise
  const rad = Math.atan2(dlon, dlat);
  return ((rad * 180 / Math.PI) + 360) % 360;
}

// ── Backlog + tick feeding ──

export function feedBacklog(backlog: Array<{ vehicles: VehiclePosition[] }>): void {
  if (backlog.length === 0) return;

  for (const tick of backlog) {
    feedTick(tick.vehicles);
  }

  // Fast-forward through all but the last tick to pre-build trail
  const ticksToConsume = backlog.length - 1;
  if (ticksToConsume <= 0) return;

  for (const [, q] of queues) {
    if (q.speed <= 0 || q.totalDist <= 0) continue;
    const targetDist = q.totalDist * (ticksToConsume / backlog.length);
    // Advance in one step — advanceAndTrail handles moving points to trail
    const fakeDt = targetDist / q.speed;
    advanceAndTrail(q, fakeDt);
  }
}

export function feedTick(vehicles: VehiclePosition[]): void {
  const now = Date.now();
  const seen = new Set<string>();

  for (const v of vehicles) {
    seen.add(v.entityId);
    let q = queues.get(v.entityId);

    if (!q) {
      q = {
        points: [[v.longitude, v.latitude]],
        dists: [0],
        totalDist: 0,
        playhead: 0,
        speed: 0,
        lastAppendAt: now,
        trail: [],
        mode: v.mode,
      };
      queues.set(v.entityId, q);
    }

    const seg = v.pathSegment && v.pathSegment.length >= 2 ? v.pathSegment : null;
    if (seg) {
      const prevTotal = q.totalDist;
      appendToQueue(q, seg);
      const addedDist = q.totalDist - prevTotal;
      const dt = now - q.lastAppendAt;
      if (dt > 0 && addedDist > 0) {
        q.speed = addedDist / dt;
      }
      q.lastAppendAt = now;
    }
  }

  for (const id of queues.keys()) {
    if (!seen.has(id)) queues.delete(id);
  }
}

// ── Compute display ──

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
    const q = queues.get(v.entityId);

    if (!q || v.stale || q.speed <= 0) {
      return {
        entityId: v.entityId, mode: v.mode,
        position: [v.longitude, v.latitude] as [number, number],
        angle: -v.bearing, stale: v.stale, speed: v.speed,
        bearing: v.bearing, routeId: v.routeId,
        vehicleId: v.vehicleId, vehicleLabel: v.vehicleLabel,
      };
    }

    const pos = advanceAndTrail(q, dtMs);

    // Bearing from actual movement direction (last two trail points)
    const bearing = bearingFromTrail(q);

    return {
      entityId: v.entityId, mode: v.mode,
      position: pos,
      angle: bearing !== 0 ? -bearing : -v.bearing,
      stale: v.stale, speed: v.speed,
      bearing: bearing || v.bearing, routeId: v.routeId,
      vehicleId: v.vehicleId, vehicleLabel: v.vehicleLabel,
    };
  });
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
    const q = queues.get(v.entityId);
    if (!q || q.trail.length < 2) continue;
    if (hasSelection && v.entityId !== selectedId) continue;
    data.push({ entityId: v.entityId, path: q.trail, mode: v.mode });
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

// ── Full route shape layer ──

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
