import { ScatterplotLayer } from "@deck.gl/layers";
import type { VehiclePosition, TransportMode } from "./types.js";

/** Mode → RGB color */
const MODE_COLORS: Record<TransportMode, [number, number, number]> = {
  metro: [52, 172, 225],
  tram: [120, 190, 32],
  bus: [255, 130, 0],
  vline: [165, 127, 178],
};

const STALE_COLOR: [number, number, number] = [128, 128, 128];

/** Mode → base radius in meters */
const MODE_RADIUS: Record<TransportMode, number> = {
  metro: 80,
  tram: 50,
  bus: 30,
  vline: 80,
};

/**
 * Build the deck.gl ScatterplotLayer for all vehicles.
 * Uses built-in transitions for smooth animation between ticks.
 */
export function createVehicleLayer(vehicles: VehiclePosition[]) {
  return new ScatterplotLayer<VehiclePosition>({
    id: "vehicles",
    data: vehicles,
    getPosition: (d) => [d.longitude, d.latitude],
    getFillColor: (d) => (d.stale ? STALE_COLOR : MODE_COLORS[d.mode]),
    getRadius: (d) => MODE_RADIUS[d.mode],
    radiusMinPixels: 3,
    radiusMaxPixels: 20,
    opacity: 0.9,
    pickable: true,
    antialiasing: true,

    transitions: {
      getPosition: {
        duration: 1000,
        easing: (t: number) => t,
      },
    },

    updateTriggers: {
      getFillColor: [vehicles.length],
    },
  });
}
