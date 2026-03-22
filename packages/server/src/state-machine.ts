import type { ServerState, TransitionLogEntry } from "./types.js";
import { logTransition } from "./logger.js";

/**
 * Valid transitions for the server state machine.
 * See .memory/state-transitions.md for the full diagram.
 */
const VALID_TRANSITIONS: Record<ServerState, ServerState[]> = {
  BOOT: ["INITIALIZING", "SHUTTING_DOWN"],
  INITIALIZING: ["AWAITING_FIRST_POLL", "FATAL", "SHUTTING_DOWN"],
  AWAITING_FIRST_POLL: ["RUNNING", "FATAL", "SHUTTING_DOWN"],
  RUNNING: ["DEGRADED", "SHUTTING_DOWN"],
  DEGRADED: ["RUNNING", "STALE", "SHUTTING_DOWN"],
  STALE: ["RUNNING", "SHUTTING_DOWN"],
  SHUTTING_DOWN: ["STOPPED"],
  STOPPED: [],
  FATAL: [],
};

export class ServerStateMachine {
  private _state: ServerState = "BOOT";

  get state(): ServerState {
    return this._state;
  }

  /**
   * Attempt a state transition.
   * Returns true if the transition was accepted, false if rejected.
   */
  transition(
    to: ServerState,
    trigger: string,
    actor: "user" | "system" | "external"
  ): boolean {
    const from = this._state;
    const valid = VALID_TRANSITIONS[from];

    if (!valid.includes(to)) {
      const entry: TransitionLogEntry = {
        timestamp: new Date().toISOString(),
        machine: "server",
        previous: from,
        attempted: to,
        rejected: true,
        reason: `Cannot transition from ${from} to ${to}. Valid targets: [${valid.join(", ")}]`,
        trigger,
        actor,
      };
      logTransition(entry);
      return false;
    }

    this._state = to;

    const entry: TransitionLogEntry = {
      timestamp: new Date().toISOString(),
      machine: "server",
      previous: from,
      new: to,
      trigger,
      actor,
    };
    logTransition(entry);
    return true;
  }

  /** Check if the server is in a terminal state */
  get isTerminal(): boolean {
    return this._state === "STOPPED" || this._state === "FATAL";
  }

  /** Check if the server should be broadcasting */
  get isBroadcasting(): boolean {
    return (
      this._state === "RUNNING" ||
      this._state === "DEGRADED" ||
      this._state === "STALE"
    );
  }
}
