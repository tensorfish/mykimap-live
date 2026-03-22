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
}

export const store = new Store<AppState>({
  clientState: "LOADING",
  worldState: null,
  lastTickAt: 0,
  selectedEntityId: null,
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
  }));
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
