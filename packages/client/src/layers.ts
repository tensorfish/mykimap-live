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

// ── Vehicle arrow layer ──
//
// Server sends positions interpolated along route shapes every 1s.
// Client renders directly — no client-side projection.
// Smooth movement comes from deck.gl transitions matching by
// stable array order (server sorts by entityId).

export function createVehicleLayer(
  vehicles: VehiclePosition[],
  selectedId: string | null
) {
  const hasSelection = selectedId !== null;

  return new IconLayer<VehiclePosition>({
    id: "vehicles",
    data: vehicles,
    iconAtlas: getArrowIconUrl(),
    iconMapping: ARROW_ICON_MAPPING,
    getIcon: () => "arrow",
    getPosition: (d) => [d.longitude, d.latitude],
    getColor: (d) => {
      if (hasSelection && d.entityId !== selectedId) return DIMMED_COLOR;
      if (d.stale) return [...STALE_COLOR, 160];
      return [...MODE_COLORS[d.mode], 230];
    },
    getSize: (d) => {
      if (hasSelection && d.entityId === selectedId) return MODE_SIZE[d.mode] * 1.4;
      return MODE_SIZE[d.mode];
    },
    getAngle: (d) => -d.bearing,
    sizeScale: 1,
    sizeUnits: "pixels" as const,
    sizeMinPixels: 8,
    sizeMaxPixels: 40,
    pickable: true,
    billboard: false,

    // Smooth transitions between 1s server ticks.
    // Server sorts by entityId so array order is stable.
    transitions: {
      getPosition: { duration: 1000, easing: (t: number) => t },
      getAngle: { duration: 1000, easing: (t: number) => t },
    },
  });
}

// ── Trail layer ──
// Trail data comes from the server, sampled from the route shape.
// It follows the road because the server interpolates along shapes.

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
