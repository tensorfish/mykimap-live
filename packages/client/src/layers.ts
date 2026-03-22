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
  /** Where the arrow was last rendered (display position) */
  displayLon: number;
  displayLat: number;
  displayBearing: number;
  /** Where the server says the vehicle should be NOW */
  targetLon: number;
  targetLat: number;
  targetBearing: number;
  /** When the target was set */
  updatedAt: number;
}

const lerpStates = new Map<string, LerpState>();
const LERP_MS = 1000;

/** Called when new server tick arrives. Target = new server position. Prev = last display. */
export function updateLerpTargets(vehicles: VehiclePosition[]): void {
  const now = Date.now();
  const seen = new Set<string>();

  for (const v of vehicles) {
    seen.add(v.entityId);
    const s = lerpStates.get(v.entityId);

    if (s) {
      // Key fix: prev becomes the LAST DISPLAYED position, not the last server position.
      // This guarantees the lerp starts from where the arrow actually IS on screen.
      s.displayLon = s.displayLon; // stays — will be overwritten by computeFrame
      s.displayLat = s.displayLat;
      s.displayBearing = s.displayBearing;
      s.targetLon = v.longitude;
      s.targetLat = v.latitude;
      s.targetBearing = v.bearing;
      s.updatedAt = now;
    } else {
      // First time — snap to server position, no lerp
      lerpStates.set(v.entityId, {
        displayLon: v.longitude, displayLat: v.latitude, displayBearing: v.bearing,
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

/** Compute lerped positions for this exact frame. Updates display positions. */
export function computeFrame(vehicles: VehiclePosition[]): DisplayVehicle[] {
  const now = Date.now();

  return vehicles.map((v) => {
    const s = lerpStates.get(v.entityId);

    if (!s || v.stale || v.speed < 0.5) {
      // No lerp — render at server position
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

    // Lerp from last display position to server target
    const lon = s.displayLon + t * (s.targetLon - s.displayLon);
    const lat = s.displayLat + t * (s.targetLat - s.displayLat);

    // Lerp bearing with wraparound
    let fromB = -s.displayBearing;
    let toB = -s.targetBearing;
    let diff = toB - fromB;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    const angle = fromB + t * diff;

    // Update the display position for the NEXT tick's lerp start
    // (only at t=1, so the display snaps to target at the end)
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
