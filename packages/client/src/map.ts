import mapboxgl from "mapbox-gl";
import { Deck } from "@deck.gl/core";
import type { VehiclePosition, TransportMode } from "./types.js";
import { store, getVehicles, getSelectedEntityId, getRouteShape, selectVehicle } from "./store.js";
import { createVehicleLayer, createTrailLayer, createRouteShapeLayer, feedTick, feedBacklog, computeFrame } from "./layers.js";

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

  map.on("mousemove", (e) => {
    if (!deck) return;
    const picked = deck.pickObject({ x: e.point.x, y: e.point.y, radius: 10 });
    map.getCanvas().style.cursor = picked?.object?.entityId ? "pointer" : "";
  });

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

  map.on("move", () => {
    if (!deck) return;
    const c = map.getCenter();
    deck.setProps({
      viewState: {
        longitude: c.lng, latitude: c.lat,
        zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
      },
    });
  });

  // ── Data flow ──

  let currentVehicles: VehiclePosition[] = [];

  // Handle initial backlog from server
  window.addEventListener("vehicle-backlog", ((e: CustomEvent) => {
    feedBacklog(e.detail.backlog);
  }) as EventListener);

  // Handle regular ticks
  store.subscribe(() => {
    const vehicles = getVehicles();
    if (vehicles.length === 0) return;
    feedTick(vehicles);
    currentVehicles = vehicles;
  });

  // ── 60fps render loop ──
  // Walks each vehicle along its path queue at constant speed.
  // The queue is fed by server ticks — animation is continuous
  // because the queue always has segments ahead.

  let lastFrameTime = performance.now();

  function renderFrame(now: number) {
    const dtMs = now - lastFrameTime;
    lastFrameTime = now;

    if (deck && currentVehicles.length > 0) {
      const selectedId = getSelectedEntityId();
      const routeShape = getRouteShape();

      const display = computeFrame(currentVehicles, dtMs);

      let selectedMode: TransportMode | null = null;
      if (selectedId) {
        const v = currentVehicles.find((v) => v.entityId === selectedId);
        if (v) selectedMode = v.mode;
      }

      deck.setProps({
        layers: [
          createRouteShapeLayer(routeShape, selectedMode),
          createTrailLayer(currentVehicles, selectedId),
          createVehicleLayer(display, selectedId),
        ],
      });
    }

    requestAnimationFrame(renderFrame);
  }

  requestAnimationFrame(renderFrame);
  map.on("load", () => onReady());
}
