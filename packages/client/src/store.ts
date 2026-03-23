import { Store } from "@tanstack/store";
import type { WorldState, ClientState } from "./types.js";
import { tryTransition } from "./state-machine.js";

// ── App state ──

export interface Filters {
  metro: boolean;
  tram: boolean;
  bus: boolean;
  vline: boolean;
}

export interface AppState {
  clientState: ClientState;
  worldState: WorldState | null;
  lastTickAt: number;
  selectedEntityId: string | null;
  routeShape: Array<[number, number]> | null;
  filters: Filters;
}

export const store = new Store<AppState>({
  clientState: "LOADING",
  worldState: null,
  lastTickAt: 0,
  selectedEntityId: null,
  routeShape: null,
  filters: { metro: true, tram: true, bus: true, vline: true },
});

// ── Derived selectors ──

export function getVehicles() {
  return store.state.worldState?.vehicles ?? [];
}

export function getAlerts() {
  return store.state.worldState?.alerts ?? [];
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

export function setFilter(key: keyof Filters, value: boolean): void {
  store.setState((prev) => ({
    ...prev,
    filters: { ...prev.filters, [key]: value },
  }));
}

// ── Actions ──

export function transition(to: ClientState, trigger: string): void {
  store.setState((prev) => ({
    ...prev,
    clientState: tryTransition(prev.clientState, to, trigger),
  }));
}

export function selectVehicle(entityId: string | null): void {
  store.setState((prev) => ({
    ...prev,
    selectedEntityId: entityId,
    routeShape: null,
  }));

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
  } catch {}
}


export function applyTick(worldState: WorldState): void {
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
