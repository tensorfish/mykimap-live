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

// ── Sizing ──

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

// ── Client-side lerp state ──

interface PrevState {
  lon: number;
  lat: number;
  bearing: number;
  timestamp: number;
}

const prevPositions = new Map<string, PrevState>();
const LERP_DURATION = 1000;

export function snapshotPositions(vehicles: VehiclePosition[]): void {
  const now = Date.now();
  const seen = new Set<string>();

  for (const v of vehicles) {
    seen.add(v.entityId);
    const prev = prevPositions.get(v.entityId);
    if (prev) {
      if (prev.lon !== v.longitude || prev.lat !== v.latitude) {
        prev.lon = v.longitude;
        prev.lat = v.latitude;
        prev.bearing = v.bearing;
        prev.timestamp = now;
      }
    } else {
      prevPositions.set(v.entityId, {
        lon: v.longitude, lat: v.latitude,
        bearing: v.bearing, timestamp: now,
      });
    }
  }

  for (const id of prevPositions.keys()) {
    if (!seen.has(id)) prevPositions.delete(id);
  }
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
    getPosition: (d) => {
      const prev = prevPositions.get(d.entityId);
      if (!prev) return [d.longitude, d.latitude];
      const elapsed = now - prev.timestamp;
      if (elapsed >= LERP_DURATION) return [d.longitude, d.latitude];
      const t = elapsed / LERP_DURATION;
      return [
        prev.lon + t * (d.longitude - prev.lon),
        prev.lat + t * (d.latitude - prev.lat),
      ];
    },
    getColor: (d) => {
      if (hasSelection && d.entityId !== selectedId) return DIMMED_COLOR;
      if (d.stale) return [...STALE_COLOR, 160];
      return [...MODE_COLORS[d.mode], 230];
    },
    getSize: (d) => {
      if (hasSelection && d.entityId === selectedId) return MODE_SIZE[d.mode] * 1.4;
      return MODE_SIZE[d.mode];
    },
    getAngle: (d) => {
      const prev = prevPositions.get(d.entityId);
      if (!prev) return -d.bearing;
      const elapsed = now - prev.timestamp;
      if (elapsed >= LERP_DURATION) return -d.bearing;
      const t = elapsed / LERP_DURATION;
      let from = -prev.bearing, to = -d.bearing, diff = to - from;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      return from + t * diff;
    },
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
    // When a vehicle is selected, only show its trail
    if (hasSelection && entityId !== selectedId) continue;
    data.push({ entityId, path, mode });
  }

  return new PathLayer<TrailData>({
    id: "trails",
    data,
    getPath: (d) => d.path,
    getColor: (d) => {
      const [r, g, b] = MODE_COLORS[d.mode];
      // Brighter trail for selected vehicle
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
