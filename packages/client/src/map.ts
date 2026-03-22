import mapboxgl from "mapbox-gl";
import { Deck } from "@deck.gl/core";
import type { VehiclePosition } from "./types.js";
import { store, getVehicles, getTrails, getSelectedEntityId, selectVehicle } from "./store.js";
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

  // deck.gl as passive overlay — Mapbox owns all mouse interaction
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

  // Click handler: use Mapbox's click event + deck.pickObject()
  // This way Mapbox keeps full control of pan/zoom/rotate,
  // and we intercept clicks only to pick vehicle objects.
  map.on("click", (e) => {
    if (!deck) return;
    const picked = deck.pickObject({
      x: e.point.x,
      y: e.point.y,
      radius: 10,
    });
    if (picked?.object?.entityId) {
      const currentSelected = getSelectedEntityId();
      if (currentSelected === picked.object.entityId) {
        selectVehicle(null);
      } else {
        selectVehicle(picked.object.entityId);
      }
    } else {
      selectVehicle(null);
    }
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

  let currentVehicles: VehiclePosition[] = [];
  let currentTrails: Record<string, Array<[number, number]>> = {};
  let animFrameId: number | null = null;

  function renderFrame() {
    if (!deck) return;
    const selectedId = getSelectedEntityId();
    deck.setProps({
      layers: [
        createTrailLayer(currentVehicles, currentTrails, selectedId),
        createVehicleLayer(currentVehicles, selectedId),
      ],
    });
    animFrameId = requestAnimationFrame(renderFrame);
  }

  // Re-render on data changes
  store.subscribe(() => {
    const vehicles = getVehicles();
    const trails = getTrails();
    if (vehicles.length === 0) return;

    snapshotPositions(vehicles);
    currentVehicles = vehicles;
    currentTrails = trails;

    if (!animFrameId) {
      animFrameId = requestAnimationFrame(renderFrame);
    }
  });

  map.on("load", () => {
    onReady();
  });
}
