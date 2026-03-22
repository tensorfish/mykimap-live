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

// ── Client-side lerp engine ──
//
// Server sends shape-interpolated positions every 1s.
// We lerp from the LAST DISPLAYED position (what the user sees)
// to the new server position over 1s at 60fps.
// Keyed by entityId — immune to array reordering.

interface LerpState {
  /** Where the arrow was last rendered */
  displayLon: number;
  displayLat: number;
  displayBearing: number;
  /** Path segment from server: route geometry between prev and current tick */
  path: Array<[number, number]>;
  /** Cumulative distances along the path for even-speed traversal */
  pathDists: number[];
  pathTotalDist: number;
  /** Target position + bearing (end of path) */
  targetLon: number;
  targetLat: number;
  targetBearing: number;
  /** When this tick was received */
  updatedAt: number;
}

const lerpStates = new Map<string, LerpState>();
const LERP_MS = 1000;

/** Compute cumulative distances for a path */
function computePathDists(path: Array<[number, number]>): { dists: number[]; total: number } {
  const dists = [0];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const dlat = path[i]![1] - path[i - 1]![1];
    const dlon = path[i]![0] - path[i - 1]![0];
    // Approximate distance in degrees → good enough for lerp pacing
    total += Math.sqrt(dlat * dlat + dlon * dlon);
    dists.push(total);
  }
  return { dists, total };
}

/** Sample a position along a path at a given fraction (0–1) */
function samplePath(path: Array<[number, number]>, dists: number[], totalDist: number, t: number): [number, number] {
  if (path.length === 0) return [0, 0];
  if (path.length === 1 || totalDist === 0) return path[0]!;

  const targetDist = t * totalDist;

  // Find segment
  for (let i = 0; i < path.length - 1; i++) {
    if (targetDist >= dists[i]! && targetDist <= dists[i + 1]!) {
      const segLen = dists[i + 1]! - dists[i]!;
      const segT = segLen > 0 ? (targetDist - dists[i]!) / segLen : 0;
      return [
        path[i]![0] + segT * (path[i + 1]![0] - path[i]![0]),
        path[i]![1] + segT * (path[i + 1]![1] - path[i]![1]),
      ];
    }
  }

  return path[path.length - 1]!;
}

/** Called when new server tick arrives */
export function updateLerpTargets(vehicles: VehiclePosition[]): void {
  const now = Date.now();
  const seen = new Set<string>();

  for (const v of vehicles) {
    seen.add(v.entityId);
    const s = lerpStates.get(v.entityId);

    // Build path: if server sent a path segment, use it.
    // Otherwise fall back to a 2-point straight line.
    let path = v.pathSegment && v.pathSegment.length >= 2
      ? v.pathSegment
      : undefined;

    if (s) {
      if (!path) {
        // No path segment — straight line from display to target
        path = [[s.displayLon, s.displayLat], [v.longitude, v.latitude]];
      }
      const { dists, total } = computePathDists(path);
      s.path = path;
      s.pathDists = dists;
      s.pathTotalDist = total;
      s.targetLon = v.longitude;
      s.targetLat = v.latitude;
      s.targetBearing = v.bearing;
      s.updatedAt = now;
    } else {
      // First time — snap
      const p: Array<[number, number]> = [[v.longitude, v.latitude]];
      lerpStates.set(v.entityId, {
        displayLon: v.longitude, displayLat: v.latitude, displayBearing: v.bearing,
        path: p, pathDists: [0], pathTotalDist: 0,
        targetLon: v.longitude, targetLat: v.latitude, targetBearing: v.bearing,
        updatedAt: now,
      });
    }
  }

  for (const id of lerpStates.keys()) {
    if (!seen.has(id)) lerpStates.delete(id);
  }
}

/** Pre-computed per-frame display data */
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

/** Compute positions for this exact frame by walking along path segments. */
export function computeFrame(vehicles: VehiclePosition[]): DisplayVehicle[] {
  const now = Date.now();

  return vehicles.map((v) => {
    const s = lerpStates.get(v.entityId);

    if (!s || v.stale || v.speed < 0.5) {
      if (s) { s.displayLon = v.longitude; s.displayLat = v.latitude; s.displayBearing = v.bearing; }
      return {
        entityId: v.entityId, mode: v.mode,
        position: [v.longitude, v.latitude] as [number, number],
        angle: -v.bearing, stale: v.stale, speed: v.speed,
        bearing: v.bearing, routeId: v.routeId,
        vehicleId: v.vehicleId, vehicleLabel: v.vehicleLabel,
      };
    }

    const elapsed = now - s.updatedAt;
    const t = Math.min(elapsed / LERP_MS, 1);

    // Walk along the path segment (actual route geometry)
    let lon: number, lat: number;
    if (s.path.length >= 2 && s.pathTotalDist > 0) {
      [lon, lat] = samplePath(s.path, s.pathDists, s.pathTotalDist, t);
    } else {
      // No path — hold position
      lon = s.displayLon;
      lat = s.displayLat;
    }

    // Lerp bearing with wraparound
    let fromB = -s.displayBearing;
    let toB = -s.targetBearing;
    let diff = toB - fromB;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    const angle = fromB + t * diff;

    // At t=1, snap display to target for the next tick's path start
    if (t >= 1) {
      s.displayLon = s.targetLon;
      s.displayLat = s.targetLat;
      s.displayBearing = s.targetBearing;
    }

    return {
      entityId: v.entityId, mode: v.mode,
      position: [lon, lat] as [number, number],
      angle, stale: v.stale, speed: v.speed,
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
  trails: Record<string, Array<[number, number]>>,
  selectedId: string | null
) {
  const modeMap = new Map<string, TransportMode>();
  for (const v of vehicles) modeMap.set(v.entityId, v.mode);

  const hasSelection = selectedId !== null;
  const data: TrailData[] = [];

  for (const [entityId, path] of Object.entries(trails)) {
    if (path.length < 2) continue;
    const mode = modeMap.get(entityId);
    if (!mode) continue;
    if (hasSelection && entityId !== selectedId) continue;
    data.push({ entityId, path, mode });
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
