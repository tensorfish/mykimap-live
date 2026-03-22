import type { TransitionLogEntry } from "./types.js";

/**
 * Structured logger for state transitions.
 * Every state change — successful or rejected — is logged.
 */
export function logTransition(entry: TransitionLogEntry): void {
  const prefix = entry.rejected ? "REJECTED" : "TRANSITION";
  const arrow = entry.rejected
    ? `${entry.previous} ✗→ ${entry.attempted}`
    : `${entry.previous} → ${entry.new}`;

  const parts = [
    `[${entry.timestamp}]`,
    `[${entry.machine}]`,
    `[${prefix}]`,
    arrow,
    `trigger="${entry.trigger}"`,
    `actor=${entry.actor}`,
  ];

  if (entry.reason) {
    parts.push(`reason="${entry.reason}"`);
  }

  console.log(parts.join(" "));
}

/** General-purpose log levels */
export function log(
  level: "info" | "warn" | "error" | "debug",
  message: string,
  data?: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();
  const line = data
    ? `[${timestamp}] [${level.toUpperCase()}] ${message} ${JSON.stringify(data)}`
    : `[${timestamp}] [${level.toUpperCase()}] ${message}`;

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
