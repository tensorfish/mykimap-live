import mapboxgl from "mapbox-gl";
import { Deck } from "@deck.gl/core";
import type { TransportMode } from "./types.js";
import { store, getVehicles, getTrails, getSelectedEntityId, getRouteShape, selectVehicle } from "./store.js";
import { createVehicleLayer, createTrailLayer, createRouteShapeLayer } from "./layers.js";

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

  // Cursor: pointer on hover
  map.on("mousemove", (e) => {
    if (!deck) return;
    const picked = deck.pickObject({ x: e.point.x, y: e.point.y, radius: 10 });
    map.getCanvas().style.cursor = picked?.object?.entityId ? "pointer" : "";
  });

  // Click: select/deselect
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

  // ── Update layers when store changes ──
  // Server interpolates along route shapes at 1s ticks.
  // deck.gl transitions handle the smooth animation between ticks.
  // No client-side projection needed.

  store.subscribe(() => {
    if (!deck) return;

    const vehicles = getVehicles();
    if (vehicles.length === 0) return;

    const trails = getTrails();
    const selectedId = getSelectedEntityId();
    const routeShape = getRouteShape();

    let selectedMode: TransportMode | null = null;
    if (selectedId) {
      const v = vehicles.find((v) => v.entityId === selectedId);
      if (v) selectedMode = v.mode;
    }

    deck.setProps({
      layers: [
        createRouteShapeLayer(routeShape, selectedMode),
        createTrailLayer(vehicles, trails, selectedId),
        createVehicleLayer(vehicles, selectedId),
      ],
    });
  });

  map.on("load", () => onReady());
}
