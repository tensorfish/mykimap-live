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

// ── Client-side interpolation state ──
// We do NOT use deck.gl transitions (they match by array index and
// splatter when vehicles enter/leave the array). Instead we lerp
// manually using a previous position map keyed by entityId.

interface PrevState {
  lon: number;
  lat: number;
  bearing: number;
  timestamp: number; // when this state was set (Date.now())
}

const prevPositions = new Map<string, PrevState>();
const LERP_DURATION = 1000; // ms — matches server broadcast interval

/**
 * Call this from the store subscriber BEFORE creating layers.
 * Captures the current positions as the "previous" state for the next tick.
 */
export function snapshotPositions(vehicles: VehiclePosition[]): void {
  const now = Date.now();
  const seen = new Set<string>();

  for (const v of vehicles) {
    seen.add(v.entityId);

    const prev = prevPositions.get(v.entityId);
    if (prev) {
      // Update: the old "current" becomes the new "previous"
      // Only update if the position actually changed
      if (prev.lon !== v.longitude || prev.lat !== v.latitude) {
        prev.lon = v.longitude;
        prev.lat = v.latitude;
        prev.bearing = v.bearing;
        prev.timestamp = now;
      }
    } else {
      // New vehicle — no lerp, just snap
      prevPositions.set(v.entityId, {
        lon: v.longitude,
        lat: v.latitude,
        bearing: v.bearing,
        timestamp: now,
      });
    }
  }

  // Remove departed vehicles
  for (const id of prevPositions.keys()) {
    if (!seen.has(id)) prevPositions.delete(id);
  }
}

// ── Vehicle arrow layer ──

export function createVehicleLayer(vehicles: VehiclePosition[]) {
  const now = Date.now();

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

      // Lerp from previous position to current
      const t = elapsed / LERP_DURATION;
      return [
        prev.lon + t * (d.longitude - prev.lon),
        prev.lat + t * (d.latitude - prev.lat),
      ];
    },
    getColor: (d) =>
      d.stale ? [...STALE_COLOR, 160] : [...MODE_COLORS[d.mode], 230],
    getSize: (d) => MODE_SIZE[d.mode],
    getAngle: (d) => {
      const prev = prevPositions.get(d.entityId);
      if (!prev) return -d.bearing;

      const elapsed = now - prev.timestamp;
      if (elapsed >= LERP_DURATION) return -d.bearing;

      // Lerp bearing (handle wraparound)
      const t = elapsed / LERP_DURATION;
      let from = -prev.bearing;
      let to = -d.bearing;
      let diff = to - from;
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
    // No deck.gl transitions — we lerp manually above with entityId keys
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
  trails: Record<string, Array<[number, number]>>
) {
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
