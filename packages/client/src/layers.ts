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

// ── Sizing ──

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
// No deck.gl transitions — the server interpolates at 1s ticks,
// positions change smoothly tick-to-tick. Adding transitions on top
// caused "splattering" because deck.gl matches by array index,
// not by entityId, so reordered arrays animate to wrong positions.

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
    // deck.gl getAngle: 0°=east, positive=counter-clockwise
    // Bearing: 0°=north, positive=clockwise
    // Conversion: angle = 90 - bearing
    getAngle: (d) => 90 - d.bearing,
    sizeScale: 1,
    sizeUnits: "pixels" as const,
    sizeMinPixels: 8,
    sizeMaxPixels: 40,
    pickable: true,
    billboard: false,
    updateTriggers: {
      getPosition: [vehicles],
      getAngle: [vehicles],
      getColor: [vehicles.length],
    },
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

/**
 * Build trail layer from server-provided trails.
 * Trails arrive as a Record<entityId, [lon,lat][]> from the server.
 */
export function createTrailLayer(
  vehicles: VehiclePosition[],
  trails: Record<string, Array<[number, number]>>
) {
  // Build a mode lookup from vehicles
  const modeMap = new Map<string, TransportMode>();
  for (const v of vehicles) {
    modeMap.set(v.entityId, v.mode);
  }

  const data: TrailData[] = [];
  for (const [entityId, path] of Object.entries(trails)) {
    if (path.length < 2) continue;
    const mode = modeMap.get(entityId);
    if (!mode) continue;
    data.push({ entityId, path, mode });
  }

  return new PathLayer<TrailData>({
    id: "trails",
    data,
    getPath: (d) => d.path,
    getColor: (d) => {
      const [r, g, b] = MODE_COLORS[d.mode];
      return [r, g, b, 100];
    },
    getWidth: (d) => TRAIL_WIDTH[d.mode],
    widthUnits: "pixels" as const,
    widthMinPixels: 1,
    widthMaxPixels: 6,
    capRounded: true,
    jointRounded: true,
    pickable: false,
  });
}
