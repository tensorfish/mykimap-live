import { Store } from "@tanstack/store";
import type { WorldState, ClientState, VehiclePosition } from "./types.js";
import { tryTransition } from "./state-machine.js";

// ── Trail config ──

/** Max trail points per vehicle */
const MAX_TRAIL_LENGTH = 40;

// ── App state ──

export interface AppState {
  clientState: ClientState;
  worldState: WorldState | null;
  lastTickAt: number;
  /** Position history per vehicle: entityId → array of [lon, lat] */
  trails: Map<string, Array<[number, number]>>;
}

export const store = new Store<AppState>({
  clientState: "LOADING",
  worldState: null,
  lastTickAt: 0,
  trails: new Map(),
});

// ── Derived selectors ──

export function getVehicles() {
  return store.state.worldState?.vehicles ?? [];
}

export function getAlerts() {
  return store.state.worldState?.alerts ?? [];
}

export function getTrails() {
  return store.state.trails;
}

// ── Actions ──

export function transition(to: ClientState, trigger: string): void {
  store.setState((prev) => ({
    ...prev,
    clientState: tryTransition(prev.clientState, to, trigger),
  }));
}

export function applyTick(worldState: WorldState): void {
  store.setState((prev) => {
    // Update trails with new positions
    const trails = new Map(prev.trails);

    for (const v of worldState.vehicles) {
      const pos: [number, number] = [v.longitude, v.latitude];
      let trail = trails.get(v.entityId);

      if (!trail) {
        trail = [];
        trails.set(v.entityId, trail);
      }

      // Only append if the vehicle actually moved (avoid duplicate points)
      const last = trail[trail.length - 1];
      if (!last || last[0] !== pos[0] || last[1] !== pos[1]) {
        trail.push(pos);
      }

      // Trim to max length
      if (trail.length > MAX_TRAIL_LENGTH) {
        trails.set(v.entityId, trail.slice(trail.length - MAX_TRAIL_LENGTH));
      }
    }

    // Remove trails for vehicles no longer in the feed
    const activeIds = new Set(worldState.vehicles.map((v) => v.entityId));
    for (const id of trails.keys()) {
      if (!activeIds.has(id)) {
        trails.delete(id);
      }
    }

    return {
      ...prev,
      worldState,
      lastTickAt: Date.now(),
      trails,
      clientState:
        prev.clientState === "WAITING_FOR_DATA" ||
        prev.clientState === "STALE"
          ? tryTransition(prev.clientState, "ACTIVE", "Tick received")
          : prev.clientState,
    };
  });
}
