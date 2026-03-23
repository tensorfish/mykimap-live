import { Store } from "@tanstack/store";
import type { WorldState, ClientState } from "./types.js";
import { tryTransition } from "./state-machine.js";
import { sounds } from "./audio.js";

// ── App state ──

export interface Filters {
  metro: boolean;
  tram: boolean;
  bus: boolean;
  vline: boolean;
}

interface AppState {
  clientState: ClientState;
  worldState: WorldState | null;
  lastTickAt: number;
  selectedEntityId: string | null;
  routeShape: Array<[number, number]> | null;
  filters: Filters;
  routeFilter: string;
  vehicleFilter: string;
  heatmapEnabled: boolean;
}

export const store = new Store<AppState>({
  clientState: "LOADING",
  worldState: null,
  lastTickAt: 0,
  selectedEntityId: null,
  routeShape: null,
  filters: { metro: true, tram: true, bus: true, vline: true },
  routeFilter: "",
  vehicleFilter: "",
  heatmapEnabled: false,
});

// ── Derived selectors ──

export function getVehicles() {
  return store.state.worldState?.vehicles ?? [];
}

export function getSelectedEntityId(): string | null {
  return store.state.selectedEntityId;
}

export function getRouteShape(): Array<[number, number]> | null {
  return store.state.routeShape;
}

export function getFilters(): Filters {
  return store.state.filters;
}

export function getRouteFilter(): string {
  return store.state.routeFilter;
}

export function getVehicleFilter(): string {
  return store.state.vehicleFilter;
}

export function setFilter(key: keyof Filters, value: boolean): void {
  store.setState((prev) => ({
    ...prev,
    filters: { ...prev.filters, [key]: value },
  }));
}

export function setRouteFilter(text: string): void {
  store.setState((prev) => ({ ...prev, routeFilter: text }));
}

export function setVehicleFilter(text: string): void {
  store.setState((prev) => ({ ...prev, vehicleFilter: text }));
}

export function getHeatmapEnabled(): boolean {
  return store.state.heatmapEnabled;
}

export function setHeatmapEnabled(enabled: boolean): void {
  store.setState((prev) => ({ ...prev, heatmapEnabled: enabled }));
}

// ── Actions ──

export function transition(to: ClientState, trigger: string): void {
  store.setState((prev) => ({
    ...prev,
    clientState: tryTransition(prev.clientState, to, trigger),
  }));
}

export function selectVehicle(entityId: string | null): void {
  const prev = store.state.selectedEntityId;
  store.setState((s) => ({
    ...s,
    selectedEntityId: entityId,
    routeShape: null,
  }));

  // Sound feedback
  if (entityId && entityId !== prev) sounds.select();
  else if (!entityId && prev) sounds.deselect();

  if (entityId) {
    const vehicle = store.state.worldState?.vehicles.find(
      (v) => v.entityId === entityId
    );
    if (vehicle) {
      fetchRouteShape(vehicle.tripId, vehicle.routeId);
    }
  }
}

async function fetchRouteShape(tripId: string, routeId: string): Promise<void> {
  try {
    const url = `/api/route-shape/${encodeURIComponent(tripId)}?routeId=${encodeURIComponent(routeId)}`;
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.path && data.path.length > 0) {
      store.setState((prev) => ({ ...prev, routeShape: data.path }));
    }
  } catch (error) {
    // Route shape fetch is non-critical — log but don't modal
    console.warn("[store] Route shape fetch failed:", error);
  }
}


/** Suppress automatic sounds during playback */
let _playbackActive = false;
export function setPlaybackActive(v: boolean): void { _playbackActive = v; }

export function applyTick(worldState: WorldState): void {
  // Detect new service alerts (live mode only)
  if (!_playbackActive) {
    const prevAlertCount = store.state.worldState?.alerts?.length ?? 0;
    const newAlertCount = worldState.alerts?.length ?? 0;
    if (newAlertCount > prevAlertCount) {
      sounds.alert();
    }
  }

  store.setState((prev) => ({
    ...prev,
    worldState,
    lastTickAt: Date.now(),
    clientState:
      prev.clientState === "WAITING_FOR_DATA" || prev.clientState === "STALE"
        ? tryTransition(prev.clientState, "ACTIVE", "Tick received")
        : prev.clientState,
  }));
}
