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

// ── Continuous path queue per vehicle ──
//
// Each vehicle has a queue of [lon, lat] waypoints built from
// pathSegments received from the server. The playhead walks along
// this queue at constant speed. As new ticks arrive, their path
// segments are appended to the end. The animation never breaks.

const TRAIL_MAX: Record<TransportMode, number> = {
  metro: 30, vline: 30, tram: 60, bus: 80,
};

interface VehicleQueue {
  /** All waypoints concatenated, in order */
  points: Array<[number, number]>;
  /** Cumulative distance at each point */
  dists: number[];
  /** Total distance of the queue */
  totalDist: number;
  /** Current playhead distance (advanced each frame) */
  playhead: number;
  /** Speed in degrees-per-ms (computed from last segment) */
  speed: number;
  /** When the last segment was appended (for speed pacing) */
  lastAppendAt: number;
  /** Target bearing from latest server tick */
  bearing: number;
  /** Previous bearing for smooth rotation */
  prevBearing: number;
  /** Client-side trail: positions the playhead has already passed */
  trail: Array<[number, number]>;
  mode: TransportMode;
}

const queues = new Map<string, VehicleQueue>();

function degDist(a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function appendToQueue(q: VehicleQueue, segment: Array<[number, number]>): void {
  for (const pt of segment) {
    const last = q.points[q.points.length - 1];
    if (last) {
      const d = degDist(last, pt);
      if (d < 1e-9) continue; // skip duplicate points
      q.totalDist += d;
    }
    q.points.push(pt);
    q.dists.push(q.totalDist);
  }
}

function trimQueue(q: VehicleQueue): void {
  // Remove consumed points (keep a few behind the playhead for safety)
  let trimTo = 0;
  for (let i = 0; i < q.dists.length - 1; i++) {
    if (q.dists[i]! < q.playhead - 0.001) trimTo = i;
    else break;
  }
  if (trimTo > 0) {
    q.points.splice(0, trimTo);
    q.dists.splice(0, trimTo);
  }
}

function sampleQueue(q: VehicleQueue): [number, number] {
  if (q.points.length === 0) return [0, 0];
  if (q.points.length === 1) return q.points[0]!;

  // Clamp playhead
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

/** Feed a backlog of ticks into the queues (on initial connect) */
export function feedBacklog(backlog: Array<{ vehicles: VehiclePosition[] }>): void {
  for (const tick of backlog) {
    feedTick(tick.vehicles);
  }
}

/** Feed a single server tick — append path segments to queues */
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
        bearing: v.bearing,
        prevBearing: v.bearing,
        trail: [],
        mode: v.mode,
      };
      queues.set(v.entityId, q);
    }

    // Append path segment from server
    const seg = v.pathSegment && v.pathSegment.length >= 2 ? v.pathSegment : null;

    if (seg) {
      const prevTotal = q.totalDist;
      appendToQueue(q, seg);
      const addedDist = q.totalDist - prevTotal;
      const dt = now - q.lastAppendAt;
      if (dt > 0 && addedDist > 0) {
        q.speed = addedDist / dt; // degrees per ms
      }
      q.lastAppendAt = now;
    }

    q.prevBearing = q.bearing;
    q.bearing = v.bearing;
  }

  // Remove departed
  for (const id of queues.keys()) {
    if (!seen.has(id)) queues.delete(id);
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

    // Advance playhead along the queue at the vehicle's speed
    const ahead = q.totalDist - q.playhead;
    if (ahead > 0) {
      q.playhead += q.speed * dtMs;
      q.playhead = Math.min(q.playhead, q.totalDist);
    }

    const pos = sampleQueue(q);
    trimQueue(q);

    // Append to client-side trail (only positions the arrow has passed)
    const lastTrail = q.trail[q.trail.length - 1];
    if (!lastTrail || Math.abs(lastTrail[0] - pos[0]) > 1e-7 || Math.abs(lastTrail[1] - pos[1]) > 1e-7) {
      q.trail.push(pos);
      const max = TRAIL_MAX[q.mode];
      if (q.trail.length > max) q.trail.splice(0, q.trail.length - max);
    }

    return {
      entityId: v.entityId, mode: v.mode,
      position: pos,
      angle: -v.bearing, stale: v.stale, speed: v.speed,
      bearing: v.bearing, routeId: v.routeId,
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
// Trail is built client-side from positions the playhead has already
// passed through. This guarantees the trail is always BEHIND the arrow.

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
