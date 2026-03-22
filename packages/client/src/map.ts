import mapboxgl from "mapbox-gl";
import { Deck } from "@deck.gl/core";
import type { VehiclePosition, TransportMode } from "./types.js";
import { store, getVehicles, getTrails, getSelectedEntityId, getRouteShape, selectVehicle } from "./store.js";
import { createVehicleLayer, createTrailLayer, createRouteShapeLayer, updateAnchors, computeDisplayVehicles } from "./layers.js";

const INITIAL_VIEW = {
  longitude: 144.963,
  latitude: -37.814,
  zoom: 13,
  pitch: 0,
  bearing: 0,
};

let deck: Deck | null = null;

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

  deck = new Deck({
    parent: container,
    viewState: INITIAL_VIEW,
    controller: false,
    layers: [],
    style: {
      position: "absolute",
      top: "0",
      left: "0",
      pointerEvents: "none",
    },
  });

  // Cursor: pointer on hover over vehicle arrows
  map.on("mousemove", (e) => {
    if (!deck) return;
    const picked = deck.pickObject({ x: e.point.x, y: e.point.y, radius: 10 });
    map.getCanvas().style.cursor = picked?.object?.entityId ? "pointer" : "";
  });

  // Click: select/deselect vehicle
  map.on("click", (e) => {
    if (!deck) return;
    const picked = deck.pickObject({ x: e.point.x, y: e.point.y, radius: 10 });
    if (picked?.object?.entityId) {
      const current = getSelectedEntityId();
      selectVehicle(current === picked.object.entityId ? null : picked.object.entityId);
    } else {
      selectVehicle(null);
    }
  });

  // Sync deck.gl viewState on Mapbox move
  map.on("move", () => {
    if (!deck) return;
    const c = map.getCenter();
    deck.setProps({
      viewState: {
        longitude: c.lng,
        latitude: c.lat,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
      },
    });
  });

  // ── State ──

  let currentVehicles: VehiclePosition[] = [];
  let currentTrails: Record<string, Array<[number, number]>> = {};

  // Update anchors when new data arrives from the server
  store.subscribe(() => {
    const vehicles = getVehicles();
    const trails = getTrails();
    if (vehicles.length === 0) return;

    updateAnchors(vehicles);
    currentVehicles = vehicles;
    currentTrails = trails;
  });

  // ── 60fps render loop ──
  // Runs continuously. Each frame computes fresh projected positions
  // for all vehicles using their speed + bearing + elapsed time.
  // This is what makes the arrows move smoothly — not server ticks.

  function renderFrame() {
    if (!deck || currentVehicles.length === 0) {
      requestAnimationFrame(renderFrame);
      return;
    }

    const selectedId = getSelectedEntityId();
    const routeShape = getRouteShape();

    // Compute projected positions for THIS frame
    const displayVehicles = computeDisplayVehicles(currentVehicles);

    // Find selected mode for route shape coloring
    let selectedMode: TransportMode | null = null;
    if (selectedId) {
      const v = currentVehicles.find((v) => v.entityId === selectedId);
      if (v) selectedMode = v.mode;
    }

    deck.setProps({
      layers: [
        createRouteShapeLayer(routeShape, selectedMode),
        createTrailLayer(currentVehicles, currentTrails, selectedId),
        createVehicleLayer(displayVehicles, selectedId),
      ],
    });

    requestAnimationFrame(renderFrame);
  }

  // Start the render loop immediately — it will render once data arrives
  requestAnimationFrame(renderFrame);

  map.on("load", () => {
    onReady();
  });
}
