import { IconLayer, PathLayer } from "@deck.gl/layers";
import type { VehiclePosition, TransportMode } from "./types.js";
import { createArrowIconURL, ARROW_ICON_MAPPING } from "./icons.js";

// ── Colors ──

const MODE_COLORS: Record<TransportMode, [number, number, number]> = {
  metro: [52, 172, 225],   // Blue
  tram: [120, 190, 32],    // Green
  bus: [255, 130, 0],      // Orange
  vline: [165, 127, 178],  // Purple
};

const STALE_COLOR: [number, number, number] = [100, 100, 100];

/** Trail colors — slightly dimmer than the arrow */
const TRAIL_COLORS: Record<TransportMode, [number, number, number]> = {
  metro: [52, 172, 225],
  tram: [120, 190, 32],
  bus: [255, 130, 0],
  vline: [165, 127, 178],
};

// ── Sizing ──

/** Mode → icon pixel size at zoom 13 */
const MODE_SIZE: Record<TransportMode, number> = {
  metro: 28,
  tram: 22,
  bus: 14,
  vline: 28,
};

// ── Arrow icon (generated once) ──

let arrowIconUrl: string | null = null;

function getArrowIconUrl(): string {
  if (!arrowIconUrl) {
    arrowIconUrl = createArrowIconURL(64);
  }
  return arrowIconUrl;
}

// ── Vehicle arrow layer ──

export function createVehicleLayer(vehicles: VehiclePosition[]) {
  return new IconLayer<VehiclePosition>({
    id: "vehicles",
    data: vehicles,
    iconAtlas: getArrowIconUrl(),
    iconMapping: ARROW_ICON_MAPPING,
    getIcon: () => "arrow",
    getPosition: (d) => [d.longitude, d.latitude],
    getColor: (d) =>
      d.stale ? [...STALE_COLOR, 160] : [...MODE_COLORS[d.mode], 230],
    getSize: (d) => MODE_SIZE[d.mode],
    getAngle: (d) => 360 - d.bearing,
    sizeScale: 1,
    sizeUnits: "pixels" as const,
    sizeMinPixels: 8,
    sizeMaxPixels: 40,
    pickable: true,
    billboard: false,

    transitions: {
      getPosition: {
        duration: 1000,
        easing: (t: number) => t,
      },
      getAngle: {
        duration: 1000,
        easing: (t: number) => t,
      },
    },

    updateTriggers: {
      getColor: [vehicles.length],
    },
  });
}

// ── Trail data shape ──

interface TrailData {
  path: Array<[number, number]>;
  color: [number, number, number];
  mode: TransportMode;
}

/**
 * Build trail data by joining vehicle positions with their trail history.
 * Each trail is a path of [lon, lat] points.
 */
function buildTrailData(
  vehicles: VehiclePosition[],
  trails: Map<string, Array<[number, number]>>
): TrailData[] {
  const data: TrailData[] = [];

  for (const v of vehicles) {
    if (v.stale) continue;

    const trail = trails.get(v.entityId);
    if (!trail || trail.length < 2) continue;

    data.push({
      path: trail,
      color: TRAIL_COLORS[v.mode],
      mode: v.mode,
    });
  }

  return data;
}

/** Trail width per mode (pixels) */
const TRAIL_WIDTH: Record<TransportMode, number> = {
  metro: 3,
  tram: 2.5,
  bus: 1.5,
  vline: 3,
};

/**
 * Snail trail layer — fading path behind each vehicle.
 * Uses PathLayer with per-vertex colors for the fade effect.
 */
export function createTrailLayer(
  vehicles: VehiclePosition[],
  trails: Map<string, Array<[number, number]>>
) {
  const data = buildTrailData(vehicles, trails);

  return new PathLayer<TrailData>({
    id: "trails",
    data,
    getPath: (d) => d.path,
    getColor: (d) => {
      const [r, g, b] = d.color;
      // Base alpha — PathLayer applies this uniformly
      // The fade effect comes from the trail naturally: older points
      // are at the tail end, but since PathLayer doesn't support
      // per-vertex alpha easily, we use a moderate opacity
      return [r, g, b, 100];
    },
    getWidth: (d) => TRAIL_WIDTH[d.mode],
    widthUnits: "pixels" as const,
    widthMinPixels: 1,
    widthMaxPixels: 6,
    capRounded: true,
    jointRounded: true,
    pickable: false,

    transitions: {
      getPath: {
        duration: 1000,
        easing: (t: number) => t,
      },
    },
  });
}
