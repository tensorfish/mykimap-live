import mapboxgl from "mapbox-gl";
import { Deck } from "@deck.gl/core";
import { store, getVehicles } from "./store.js";
import { createVehicleLayer } from "./layers.js";
import { transition } from "./store.js";

// Melbourne CBD
const INITIAL_VIEW = {
  longitude: 144.963,
  latitude: -37.814,
  zoom: 13,
  pitch: 0,
  bearing: 0,
};

let deck: Deck | null = null;

/**
 * Initialize the Mapbox base map and deck.gl overlay.
 * Subscribes to the store — whenever worldState changes,
 * the vehicle layer is rebuilt automatically.
 */
export function initMap(
  container: HTMLDivElement,
  mapboxToken: string
): void {
  mapboxgl.accessToken = mapboxToken;

  const map = new mapboxgl.Map({
    container,
    style: "mapbox://styles/mapbox/dark-v11",
    center: [INITIAL_VIEW.longitude, INITIAL_VIEW.latitude],
    zoom: INITIAL_VIEW.zoom,
    pitch: INITIAL_VIEW.pitch,
    bearing: INITIAL_VIEW.bearing,
    antialias: true,
  });

  deck = new Deck({
    parent: container,
    viewState: INITIAL_VIEW,
    controller: true,
    layers: [],
    style: { position: "absolute", top: "0", left: "0" },

    // Sync deck.gl viewState with Mapbox on user interaction
    onViewStateChange: ({ viewState }) => {
      map.jumpTo({
        center: [viewState.longitude, viewState.latitude],
        zoom: viewState.zoom,
        bearing: viewState.bearing,
        pitch: viewState.pitch,
      });
    },

    getTooltip: ({ object }: any) => {
      if (!object) return null;
      return {
        text: [
          `${object.mode.toUpperCase()}`,
          `Route: ${object.routeId}`,
          `Vehicle: ${object.vehicleId}`,
          object.vehicleLabel ? `Class: ${object.vehicleLabel}` : "",
          object.stale ? "⚠ Stale position" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  });

  // Subscribe to store changes — update layers when vehicles change
  store.subscribe(() => {
    if (!deck) return;
    const vehicles = getVehicles();
    deck.setProps({
      layers: [createVehicleLayer(vehicles)],
    });
  });

  // Map ready — signal the state machine
  map.on("load", () => {
    transition("CONNECTING", "Map loaded");
  });

  map.on("error", (e) => {
    console.error("[map] Error:", e);
    transition("ERROR", `Map error: ${e.error?.message ?? "unknown"}`);
  });
}
