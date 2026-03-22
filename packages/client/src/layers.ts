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

// ── Arrow icon ──

let arrowIconUrl: string | null = null;
function getArrowIconUrl(): string {
  if (!arrowIconUrl) arrowIconUrl = createArrowIconURL(64);
  return arrowIconUrl;
}

// ── Continuous projection engine ──

const DEG_TO_RAD = Math.PI / 180;

interface Anchor {
  lon: number;
  lat: number;
  bearing: number;
  speed: number;
  receivedAt: number;
}

const anchors = new Map<string, Anchor>();

export function updateAnchors(vehicles: VehiclePosition[]): void {
  const now = Date.now();
  const seen = new Set<string>();

  for (const v of vehicles) {
    seen.add(v.entityId);
    const existing = anchors.get(v.entityId);

    if (existing) {
      // Always update anchor to latest server position.
      // The projection runs forward from here.
      existing.lon = v.longitude;
      existing.lat = v.latitude;
      existing.bearing = v.bearing;
      existing.speed = v.speed;
      existing.receivedAt = now;
    } else {
      anchors.set(v.entityId, {
        lon: v.longitude,
        lat: v.latitude,
        bearing: v.bearing,
        speed: v.speed,
        receivedAt: now,
      });
    }
  }

  for (const id of anchors.keys()) {
    if (!seen.has(id)) anchors.delete(id);
  }
}

/** Pre-computed per-frame display data for one vehicle */
interface DisplayVehicle {
  entityId: string;
  mode: TransportMode;
  position: [number, number];
  angle: number;
  stale: boolean;
  routeId: string;
  vehicleId: string;
  vehicleLabel: string;
  bearing: number;
  speed: number;
}

/**
 * Compute display positions for ALL vehicles at the current instant.
 * Called every requestAnimationFrame. Returns a new array each time
 * so deck.gl always re-evaluates.
 */
export function computeDisplayVehicles(vehicles: VehiclePosition[]): DisplayVehicle[] {
  const now = Date.now();

  return vehicles.map((v) => {
    const a = anchors.get(v.entityId);

    let lon = v.longitude;
    let lat = v.latitude;

    if (a && a.speed >= 0.5 && !v.stale) {
      const elapsedSec = (now - a.receivedAt) / 1000;
      const distM = a.speed * elapsedSec;
      const bearingRad = a.bearing * DEG_TO_RAD;
      lat = a.lat + (distM * Math.cos(bearingRad)) / 111_000;
      lon = a.lon + (distM * Math.sin(bearingRad)) / (111_000 * Math.cos(a.lat * DEG_TO_RAD));
    }

    return {
      entityId: v.entityId,
      mode: v.mode,
      position: [lon, lat] as [number, number],
      angle: -(a?.bearing ?? v.bearing),
      stale: v.stale,
      routeId: v.routeId,
      vehicleId: v.vehicleId,
      vehicleLabel: v.vehicleLabel,
      bearing: v.bearing,
      speed: v.speed,
    };
  });
}

// ── Vehicle arrow layer ──

export function createVehicleLayer(
  displayVehicles: DisplayVehicle[],
  selectedId: string | null
) {
  const hasSelection = selectedId !== null;

  return new IconLayer<DisplayVehicle>({
    id: "vehicles",
    data: displayVehicles,
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
