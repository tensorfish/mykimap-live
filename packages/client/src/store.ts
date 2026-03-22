import { Store } from "@tanstack/store";
import type { WorldState, ClientState } from "./types.js";
import { tryTransition } from "./state-machine.js";

// ── App state ──

export interface AppState {
  clientState: ClientState;
  worldState: WorldState | null;
  lastTickAt: number;
  /** Currently selected vehicle entityId, or null */
  selectedEntityId: string | null;
  /** Full route shape for the selected vehicle: [lon, lat][] */
  routeShape: Array<[number, number]> | null;
}

export const store = new Store<AppState>({
  clientState: "LOADING",
  worldState: null,
  lastTickAt: 0,
  selectedEntityId: null,
  routeShape: null,
});

// ── Derived selectors ──

export function getVehicles() {
  return store.state.worldState?.vehicles ?? [];
}

export function getAlerts() {
  return store.state.worldState?.alerts ?? [];
}

export function getTrails(): Record<string, Array<[number, number]>> {
  return store.state.worldState?.trails ?? {};
}

export function getSelectedEntityId(): string | null {
  return store.state.selectedEntityId;
}

// ── Actions ──

export function selectVehicle(entityId: string | null): void {
  store.setState((prev) => ({
    ...prev,
    selectedEntityId: entityId,
    routeShape: null, // Clear until fetched
  }));

  // Fetch route shape from server if selecting a vehicle
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
      store.setState((prev) => ({
        ...prev,
        routeShape: data.path,
      }));
    }
  } catch {
    // Non-fatal — route shape is optional
  }
}

export function getRouteShape(): Array<[number, number]> | null {
  return store.state.routeShape;
}

export function transition(to: ClientState, trigger: string): void {
  store.setState((prev) => ({
    ...prev,
    clientState: tryTransition(prev.clientState, to, trigger),
  }));
}

export function applyTick(worldState: WorldState): void {
  store.setState((prev) => ({
    ...prev,
    worldState,
    lastTickAt: Date.now(),
    clientState:
      prev.clientState === "WAITING_FOR_DATA" ||
      prev.clientState === "STALE"
        ? tryTransition(prev.clientState, "ACTIVE", "Tick received")
        : prev.clientState,
  }));
}
