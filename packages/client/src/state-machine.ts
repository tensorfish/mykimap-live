import type { ClientState } from "./types.js";

const VALID_TRANSITIONS: Record<ClientState, ClientState[]> = {
  LOADING: ["CONNECTING", "ERROR"],
  CONNECTING: ["WAITING_FOR_DATA", "RECONNECTING"],
  WAITING_FOR_DATA: ["ACTIVE", "RECONNECTING"],
  ACTIVE: ["STALE", "RECONNECTING"],
  STALE: ["ACTIVE", "RECONNECTING"],
  RECONNECTING: ["CONNECTING", "DISCONNECTED"],
  DISCONNECTED: ["CONNECTING"],
  ERROR: [],
};

/**
 * Attempt a client state transition. Returns the new state if valid,
 * or the current state if the transition is rejected.
 */
export function tryTransition(
  current: ClientState,
  to: ClientState,
  trigger: string
): ClientState {
  const valid = VALID_TRANSITIONS[current];

  if (!valid.includes(to)) {
    console.warn(
      `[client] Rejected transition: ${current} → ${to} (trigger: ${trigger})`
    );
    return current;
  }

  console.log(`[client] ${current} → ${to} (trigger: ${trigger})`);
  return to;
}
