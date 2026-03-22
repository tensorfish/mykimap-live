import { config } from "./config.js";
import { ServerStateMachine } from "./state-machine.js";
import { loadProtoSchema } from "./poller/decoder.js";
import { poll } from "./poller/index.js";
import { processSnapshot, interpolate } from "./interpolation/index.js";
import { addClient, removeClient, broadcast, clientCount } from "./broadcast/index.js";
import { loadShapes, shapeStats } from "./shapes/index.js";
import { log } from "./logger.js";
import type { VehiclePosition, ServiceAlert, WorldState } from "./types.js";

// ── State ──

const sm = new ServerStateMachine();
let currentVehicles: VehiclePosition[] = [];
let currentAlerts: ServiceAlert[] = [];
let lastPollTimestamp = 0;
let lastHeaderTimestamp = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let broadcastTimer: ReturnType<typeof setInterval> | null = null;

// ── Boot sequence ──

async function boot(): Promise<void> {
  sm.transition("INITIALIZING", "Process entry", "system");

  // Load protobuf schema
  try {
    await loadProtoSchema();
  } catch (error) {
    sm.transition("FATAL", `Proto schema load failed: ${error}`, "system");
    process.exit(1);
  }

  // Load GTFS route shapes for road-snapped interpolation
  try {
    await loadShapes();
    const stats = shapeStats();
    log("info", `Route shapes ready`, stats);
  } catch (error) {
    // Non-fatal — fall back to straight-line interpolation
    log("warn", `Failed to load route shapes, falling back to straight-line interpolation: ${error}`);
  }

  // Start HTTP + WebSocket server
  try {
    startServer();
  } catch (error) {
    sm.transition("FATAL", `Server bind failed: ${error}`, "system");
    process.exit(1);
  }

  sm.transition("AWAITING_FIRST_POLL", "Config loaded, server bound", "system");

  // Execute first poll with retries
  let firstPollSuccess = false;
  for (let attempt = 1; attempt <= config.firstPollMaxRetries; attempt++) {
    log("info", `First poll attempt ${attempt}/${config.firstPollMaxRetries}`);
    const result = await poll();

    if (result.hasPositions) {
      currentVehicles = processSnapshot(result.vehicles, result.headerTimestamp);
      currentAlerts = result.alerts;
      lastPollTimestamp = Date.now();
      lastHeaderTimestamp = result.headerTimestamp;
      firstPollSuccess = true;
      break;
    }

    if (attempt < config.firstPollMaxRetries) {
      log("warn", `First poll attempt ${attempt} failed, retrying in 5s...`);
      await Bun.sleep(5000);
    }
  }

  if (!firstPollSuccess) {
    sm.transition(
      "FATAL",
      "All vehicle position feeds failed after retries",
      "external"
    );
    process.exit(1);
  }

  sm.transition("RUNNING", "First poll succeeded", "external");

  // Start polling loop
  pollTimer = setInterval(pollCycle, config.pollIntervalMs);

  // Start broadcast loop
  broadcastTimer = setInterval(broadcastCycle, config.broadcastIntervalMs);

  log("info", `Server running`, {
    port: config.port,
    pollInterval: config.pollIntervalMs,
    broadcastInterval: config.broadcastIntervalMs,
    vehicles: currentVehicles.length,
    alerts: currentAlerts.length,
  });
}

// ── Poll cycle ──

async function pollCycle(): Promise<void> {
  try {
    const result = await poll();

    if (result.hasPositions) {
      const isFresh = result.headerTimestamp > lastHeaderTimestamp;

      if (isFresh) {
        // Feed data changed — process the new snapshot
        currentVehicles = processSnapshot(result.vehicles, result.headerTimestamp);
        currentAlerts = result.alerts;
        lastHeaderTimestamp = result.headerTimestamp;
        log("info", `Fresh data`, { headerTimestamp: result.headerTimestamp, vehicles: currentVehicles.length });

        // FUTURE: recorder.insert(snapshot) goes here — only on fresh data
      } else {
        log("debug", `Duplicate poll skipped (header timestamp unchanged: ${result.headerTimestamp})`);
      }

      lastPollTimestamp = Date.now();

      // Recover from degraded/stale back to running
      if (sm.state === "DEGRADED" || sm.state === "STALE") {
        sm.transition("RUNNING", "Poll succeeded", "external");
      }
    } else {
      // All position feeds failed
      const timeSinceLastPoll = Date.now() - lastPollTimestamp;

      if (sm.state === "RUNNING") {
        sm.transition("DEGRADED", "All position feeds failed", "external");
      } else if (
        sm.state === "DEGRADED" &&
        timeSinceLastPoll > config.stalePollThresholdMs
      ) {
        sm.transition(
          "STALE",
          `No successful poll for ${timeSinceLastPoll}ms`,
          "system"
        );
      }
    }

    // Partial failures: some feeds failed but positions still came through
    if (result.feedResults.failed.length > 0 && result.hasPositions) {
      if (sm.state === "RUNNING") {
        sm.transition(
          "DEGRADED",
          `Partial feed failures: ${result.feedResults.failed.join(", ")}`,
          "external"
        );
      }
    }
  } catch (error) {
    log("error", `Poll cycle error: ${error}`);
  }
}

// ── Broadcast cycle ──

let lastBroadcastTime = Date.now();

function broadcastCycle(): void {
  if (!sm.isBroadcasting) return;
  if (clientCount() === 0) return;

  const now = Date.now();
  const deltaMs = now - lastBroadcastTime;
  lastBroadcastTime = now;

  // Interpolate positions forward
  const interpolated = interpolate(currentVehicles, deltaMs);

  const state: WorldState = {
    timestamp: Math.floor(now / 1000),
    vehicles: interpolated,
    alerts: currentAlerts,
    serverState: sm.state,
  };

  broadcast(state);
}

// ── HTTP + WebSocket server ──

function startServer(): void {
  Bun.serve({
    port: config.port,
    hostname: config.host,

    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req);
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }

      // Health check
      if (url.pathname === "/health") {
        return Response.json({
          state: sm.state,
          vehicles: currentVehicles.length,
          alerts: currentAlerts.length,
          clients: clientCount(),
          lastPoll: lastPollTimestamp,
        });
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        addClient(ws);

        // Send initial state immediately
        if (sm.isBroadcasting) {
          const state: WorldState = {
            timestamp: Math.floor(Date.now() / 1000),
            vehicles: currentVehicles,
            alerts: currentAlerts,
            serverState: sm.state,
          };
          ws.send(JSON.stringify(state));
        }
      },
      message(_ws, _message) {
        // Clients don't send messages — this is a one-way broadcast
      },
      close(ws) {
        removeClient(ws);
      },
    },
  });

  log("info", `HTTP + WebSocket server listening on ${config.host}:${config.port}`);
}

// ── Graceful shutdown ──

function shutdown(): void {
  log("info", "Shutdown initiated");
  sm.transition("SHUTTING_DOWN", "SIGINT/SIGTERM received", "user");

  if (pollTimer) clearInterval(pollTimer);
  if (broadcastTimer) clearInterval(broadcastTimer);

  sm.transition("STOPPED", "Cleanup complete", "system");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Start ──

boot().catch((error) => {
  log("error", `Boot failed: ${error}`);
  process.exit(1);
});
