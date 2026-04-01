import mapboxgl from "mapbox-gl";
import { Deck } from "@deck.gl/core";
import type { VehiclePosition, TransportMode } from "./types.js";
import { store, getVehicles, getSelectedEntityId, getRouteShape, getFilters, getRouteFilter, getVehicleFilter, getHeatmapEnabled, selectVehicle } from "./store.js";
import { createVehicleLayer, createTrailLayer, createRouteShapeLayer, createHeatmapLayer, feedWorldState, feedBacklog, seedHeatmap, computeFrame } from "./layers.js";
import { getAnimationSpeedMultiplier, advancePlayback } from "./playback.js";

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
    try {
      const picked = deck.pickObject({ x: e.point.x, y: e.point.y, radius: 10 });
      map.getCanvas().style.cursor = picked?.object?.entityId ? "pointer" : "";
    } catch {}
  });

  map.on("click", (e) => {
    if (!deck) return;
    let picked: { object?: { entityId?: string } } | null = null;
    try { picked = deck.pickObject({ x: e.point.x, y: e.point.y, radius: 10 }); } catch { return; }
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

  // ── Data ──

  let currentVehicles: VehiclePosition[] = [];

  window.addEventListener("vehicle-backlog", ((e: CustomEvent) => {
    feedBacklog(e.detail.backlog);
  }) as EventListener);

  window.addEventListener("congestion-seed", ((e: CustomEvent) => {
    const nowTs = Math.floor(Date.now() / 1000);
    seedHeatmap(e.detail.congestion, nowTs);
  }) as EventListener);

  let lastWorldStateRef = store.state.worldState;

  store.subscribe(() => {
    try {
      const worldState = store.state.worldState;
      const vehicles = getVehicles();
      if (vehicles.length === 0 || !worldState) return;
      currentVehicles = vehicles;
      if (worldState === lastWorldStateRef) return;
      lastWorldStateRef = worldState;
      feedWorldState(worldState);
    } catch (e) {
      console.error("[map] feedWorldState error:", e);
    }
  });

  // ── 60fps render loop ──
  // Advances each arrow along its route shape toward the target distance.
  // Capped at 100ms per frame to prevent huge jumps after tab was hidden.

  let lastFrameTime = performance.now();
  const MAX_FRAME_DT_MS = 100;

  // Reset frame clock when tab becomes visible again.
  // Without this, the first frame after a background period has a
  // delta of seconds/minutes, causing animation to misbehave.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      lastFrameTime = performance.now();
    }
  });

  function renderFrame(now: number) {
    try {
      const rawDtMs = now - lastFrameTime;
      lastFrameTime = now;
      // Cap to prevent huge jumps when tab was backgrounded or GC paused
      const dtMs = Math.min(rawDtMs, MAX_FRAME_DT_MS);

      // Advance playback timestamp (no-op if not in playback mode)
      advancePlayback(dtMs);

      if (deck && currentVehicles.length > 0) {
        const selectedId = getSelectedEntityId();
        const routeShape = getRouteShape();
        const filters = getFilters();

        const rq = getRouteFilter().toLowerCase();
        const vq = getVehicleFilter().toLowerCase();

        const filtered = currentVehicles.filter((v) => {
          if (!filters[v.mode]) return false;
          if (rq && !v.routeId.toLowerCase().includes(rq) && !v.entityId.toLowerCase().includes(rq)) return false;
          if (vq && !v.vehicleId.toLowerCase().includes(vq) && !v.vehicleLabel.toLowerCase().includes(vq)) return false;
          return true;
        });

        const speedMult = getAnimationSpeedMultiplier();
        const display = computeFrame(filtered, dtMs * speedMult);

        let selectedMode: TransportMode | null = null;
        if (selectedId) {
          const v = currentVehicles.find((v) => v.entityId === selectedId);
          if (v) selectedMode = v.mode;
        }

        const layers: any[] = [
          createRouteShapeLayer(routeShape, selectedMode),
        ];

        if (getHeatmapEnabled()) {
          const wsTs = store.state.worldState?.timestamp ?? Math.floor(Date.now() / 1000);
          layers.push(createHeatmapLayer(wsTs));
        }

        layers.push(
          createTrailLayer(filtered, selectedId),
          createVehicleLayer(display, selectedId),
        );

        deck.setProps({ layers });
      }
    } catch (e) {
      console.error("[map] renderFrame error:", e);
    } finally {
      // ALWAYS reschedule — an exception must not kill the render loop
      requestAnimationFrame(renderFrame);
    }
  }

  requestAnimationFrame(renderFrame);
  map.on("load", () => {
    const loadingEl = document.getElementById("map-loading");
    if (loadingEl) {
      loadingEl.classList.add("hidden");
      setTimeout(() => loadingEl.remove(), 500);
    }
    onReady();
  });
}
