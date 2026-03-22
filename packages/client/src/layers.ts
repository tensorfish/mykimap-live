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
  metro: 28,
  tram: 22,
  bus: 14,
  vline: 28,
};

// ── Arrow icon ──

let arrowIconUrl: string | null = null;
function getArrowIconUrl(): string {
  if (!arrowIconUrl) arrowIconUrl = createArrowIconURL(64);
  return arrowIconUrl;
}

// ── Continuous projection state ──
//
// Each vehicle has an "anchor" — its last known server position.
// Every frame, we project forward from the anchor using speed + bearing.
// When a new tick arrives, we smoothly blend from the projected position
// to the new anchor over CORRECTION_MS to avoid snapping.

const DEG_TO_RAD = Math.PI / 180;

interface Anchor {
  /** Server-sent position (the ground truth) */
  lon: number;
  lat: number;
  bearing: number;
  speed: number; // m/s
  /** When this anchor was received */
  receivedAt: number;
  /** Position we were projecting to when the correction started */
  correctionFromLon: number;
  correctionFromLat: number;
  correctionFromBearing: number;
  /** Whether we're in a correction blend */
  correcting: boolean;
}

const anchors = new Map<string, Anchor>();
const CORRECTION_MS = 300; // Blend from projected → new anchor over this duration

/**
 * Called when a new server tick arrives.
 * Updates anchors for all vehicles. If a vehicle was already being
 * projected, we record where it was so we can blend to the new position.
 */
export function updateAnchors(vehicles: VehiclePosition[]): void {
  const now = Date.now();
  const seen = new Set<string>();

  for (const v of vehicles) {
    seen.add(v.entityId);
    const existing = anchors.get(v.entityId);

    if (existing && (existing.lon !== v.longitude || existing.lat !== v.latitude)) {
      // Vehicle moved — record where we were projecting to, then update anchor
      const projected = projectFromAnchor(existing, now);
      existing.correctionFromLon = projected[0];
      existing.correctionFromLat = projected[1];
      existing.correctionFromBearing = existing.bearing;
      existing.correcting = true;
      existing.lon = v.longitude;
      existing.lat = v.latitude;
      existing.bearing = v.bearing;
      existing.speed = v.speed;
      existing.receivedAt = now;
    } else if (!existing) {
      // New vehicle — no correction needed, just set anchor
      anchors.set(v.entityId, {
        lon: v.longitude,
        lat: v.latitude,
        bearing: v.bearing,
        speed: v.speed,
        receivedAt: now,
        correctionFromLon: v.longitude,
        correctionFromLat: v.latitude,
        correctionFromBearing: v.bearing,
        correcting: false,
      });
    } else {
      // Same position — just update speed/bearing if changed
      existing.speed = v.speed;
      if (v.bearing !== 0) existing.bearing = v.bearing;
    }
  }

  for (const id of anchors.keys()) {
    if (!seen.has(id)) anchors.delete(id);
  }
}

/**
 * Project a vehicle forward from its anchor by elapsed time.
 * Simple flat-earth approximation — accurate enough for < 30s of projection.
 */
function projectFromAnchor(a: Anchor, now: number): [number, number] {
  if (a.speed < 0.5) return [a.lon, a.lat];

  const elapsedSec = (now - a.receivedAt) / 1000;
  const distM = a.speed * elapsedSec;

  const bearingRad = a.bearing * DEG_TO_RAD;
  const latOffset = (distM * Math.cos(bearingRad)) / 111_000;
  const lonOffset = (distM * Math.sin(bearingRad)) / (111_000 * Math.cos(a.lat * DEG_TO_RAD));

  return [a.lon + lonOffset, a.lat + latOffset];
}

/**
 * Get the display position for a vehicle right now.
 * Projects forward from anchor, with correction blending if needed.
 */
function getDisplayPosition(entityId: string, serverLon: number, serverLat: number, now: number): [number, number] {
  const a = anchors.get(entityId);
  if (!a) return [serverLon, serverLat];

  // Project forward from the anchor
  const projected = projectFromAnchor(a, now);

  if (!a.correcting) return projected;

  // Blend from old projected position to new projected position
  const correctionElapsed = now - a.receivedAt;
  if (correctionElapsed >= CORRECTION_MS) {
    a.correcting = false;
    return projected;
  }

  const t = correctionElapsed / CORRECTION_MS;
  // Ease out for smooth deceleration into the correct position
  const ease = 1 - (1 - t) * (1 - t);

  return [
    a.correctionFromLon + ease * (projected[0] - a.correctionFromLon),
    a.correctionFromLat + ease * (projected[1] - a.correctionFromLat),
  ];
}

function getDisplayBearing(entityId: string, serverBearing: number, now: number): number {
  const a = anchors.get(entityId);
  if (!a || !a.correcting) return -serverBearing;

  const correctionElapsed = now - a.receivedAt;
  if (correctionElapsed >= CORRECTION_MS) return -serverBearing;

  const t = correctionElapsed / CORRECTION_MS;
  const ease = 1 - (1 - t) * (1 - t);
  let from = -a.correctionFromBearing;
  let to = -serverBearing;
  let diff = to - from;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return from + ease * diff;
}

// ── Vehicle arrow layer ──

export function createVehicleLayer(
  vehicles: VehiclePosition[],
  selectedId: string | null
) {
  const now = Date.now();
  const hasSelection = selectedId !== null;

  return new IconLayer<VehiclePosition>({
    id: "vehicles",
    data: vehicles,
    iconAtlas: getArrowIconUrl(),
    iconMapping: ARROW_ICON_MAPPING,
    getIcon: () => "arrow",
    getPosition: (d) => getDisplayPosition(d.entityId, d.longitude, d.latitude, now),
    getColor: (d) => {
      if (hasSelection && d.entityId !== selectedId) return DIMMED_COLOR;
      if (d.stale) return [...STALE_COLOR, 160];
      return [...MODE_COLORS[d.mode], 230];
    },
    getSize: (d) => {
      if (hasSelection && d.entityId === selectedId) return MODE_SIZE[d.mode] * 1.4;
      return MODE_SIZE[d.mode];
    },
    getAngle: (d) => getDisplayBearing(d.entityId, d.bearing, now),
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
  metro: 3,
  tram: 2.5,
  bus: 1.5,
  vline: 3,
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

// ── Full route shape layer (shown when a vehicle is selected) ──

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
