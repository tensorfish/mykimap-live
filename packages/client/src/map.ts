import mapboxgl from "mapbox-gl";
import { Deck } from "@deck.gl/core";
import type { VehiclePosition } from "./types.js";
import { store, getVehicles, getTrails } from "./store.js";
import { createVehicleLayer, createTrailLayer, snapshotPositions } from "./layers.js";

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
 *
 * Mapbox owns all user interaction (pan, zoom, rotate).
 * deck.gl renders as a passive overlay — no controller.
 * On each Mapbox move event, we sync deck.gl's viewState.
 *
 * `onReady` is called exactly once when the map finishes loading.
 */
export function initMap(
  container: HTMLDivElement,
  mapboxToken: string,
  onReady: () => void
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

  // deck.gl as a passive overlay — Mapbox handles interaction
  deck = new Deck({
    parent: container,
    viewState: INITIAL_VIEW,
    controller: false, // Mapbox owns pan/zoom/rotate
    layers: [],
    style: {
      position: "absolute",
      top: "0",
      left: "0",
      pointerEvents: "none", // Let mouse events pass through to Mapbox
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

  // Sync deck.gl viewState whenever Mapbox moves
  function syncViewState() {
    if (!deck) return;
    const center = map.getCenter();
    deck.setProps({
      viewState: {
        longitude: center.lng,
        latitude: center.lat,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
      },
    });
  }

  map.on("move", syncViewState);

  // ── Render loop ──
  // On each new WS tick: snapshot previous positions, then start a
  // requestAnimationFrame loop that lerps arrows from old → new over 1s.
  // This gives smooth 60fps movement keyed by entityId, not array index.

  let currentVehicles: VehiclePosition[] = [];
  let currentTrails: Record<string, Array<[number, number]>> = {};
  let animFrameId: number | null = null;

  function renderFrame() {
    if (!deck) return;
    deck.setProps({
      layers: [
        createTrailLayer(currentVehicles, currentTrails),
        createVehicleLayer(currentVehicles),
      ],
    });
    animFrameId = requestAnimationFrame(renderFrame);
  }

  store.subscribe(() => {
    const vehicles = getVehicles();
    const trails = getTrails();
    if (vehicles.length === 0) return;

    // Snapshot old positions before updating — lerp uses these
    snapshotPositions(vehicles);
    currentVehicles = vehicles;
    currentTrails = trails;

    // Start render loop if not already running
    if (!animFrameId) {
      animFrameId = requestAnimationFrame(renderFrame);
    }
  });

  // Map ready — fire callback exactly once
  map.on("load", () => {
    onReady();
  });
}
