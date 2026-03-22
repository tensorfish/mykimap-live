import { Store } from "@tanstack/store";
import type { WorldState, ClientState } from "./types.js";
import { tryTransition } from "./state-machine.js";

// ── App state ──

export interface AppState {
  clientState: ClientState;
  worldState: WorldState | null;
  lastTickAt: number;
}

export const store = new Store<AppState>({
  clientState: "LOADING",
  worldState: null,
  lastTickAt: 0,
});

// ── Derived selectors (pull from store.state directly) ──

export function getVehicles() {
  return store.state.worldState?.vehicles ?? [];
}

export function getAlerts() {
  return store.state.worldState?.alerts ?? [];
}

// ── Actions ──

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
    // Transition to ACTIVE if we were waiting
    clientState:
      prev.clientState === "WAITING_FOR_DATA" ||
      prev.clientState === "STALE"
        ? tryTransition(prev.clientState, "ACTIVE", "Tick received")
        : prev.clientState,
  }));
}
