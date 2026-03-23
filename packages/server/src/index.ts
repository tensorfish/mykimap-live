import { config } from "./config.js";
import { ServerStateMachine } from "./state-machine.js";
import { loadProtoSchema } from "./poller/decoder.js";
import { poll } from "./poller/index.js";
import { processSnapshot, interpolate } from "./interpolation/index.js";
import { addClient, removeClient, broadcast, clientCount, closeAllClients } from "./broadcast/index.js";
import { loadShapes, shapeStats, getShapeForTrip, getShapeForRoute } from "./shapes/index.js";
import { initRecorder, recordSnapshot, closeRecorder, listRecordingDates, exportParquet, getSnapshotMeta, exportParquetRange } from "./recorder/index.js";
import { recordCongestion, getCongestion } from "./congestion/index.js";
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
let broadcastSeq = 0;

/** Recent broadcast ticks sent to new clients on connect.
 *  Client places arrows at the oldest position and animates them
 *  forward to the latest over ~3 seconds. Larger backlog = more
 *  visible initial movement. At 1 tick/s, 15 ticks = 15s of travel. */
const BACKLOG_SIZE = 15;
const tickBacklog: WorldState[] = [];

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

  // Initialize DuckDB recorder (if enabled)
  try {
    initRecorder();
  } catch (error) {
    log("warn", `Recorder init failed (non-fatal): ${error}`);
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
        // Record RAW feed data before processing (faithful copy of API response)
        recordSnapshot(result.vehicles, result.headerTimestamp).catch(() => {});

        // Process: snap to shapes, calculate speed/bearing, interpolate
        currentVehicles = processSnapshot(result.vehicles, result.headerTimestamp);
        currentAlerts = result.alerts;
        lastHeaderTimestamp = result.headerTimestamp;

        // Record vehicle speeds for congestion heatmap
        recordCongestion(currentVehicles, result.headerTimestamp);

        log("info", `Fresh data`, { headerTimestamp: result.headerTimestamp, vehicles: currentVehicles.length });
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

  const now = Date.now();
  lastBroadcastTime = now;

  const interpolated = interpolate(currentVehicles)
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));

  broadcastSeq++;
  const state: WorldState = {
    timestamp: Math.floor(now / 1000),
    vehicles: interpolated,
    alerts: currentAlerts,
    congestion: [],
    serverState: sm.state,
    seq: broadcastSeq,
  };

  // Store in backlog for new client bootstrap
  tickBacklog.push(state);
  if (tickBacklog.length > BACKLOG_SIZE) {
    tickBacklog.shift();
  }

  if (clientCount() > 0) {
    broadcast(state);
  }
}

// ── Rate limiting ──

/** Simple sliding-window rate limiter per IP */
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX_REQUESTS = 120;  // per window
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  return bucket.count <= RATE_MAX_REQUESTS;
}

// Clean stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) {
    if (now > b.resetAt) rateBuckets.delete(ip);
  }
}, 5 * 60_000);

/** CORS headers for all responses */
function withCors(resp: Response): Response {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return resp;
}

// ── HTTP + WebSocket server ──

function startServer(): void {
  Bun.serve({
    port: config.port,
    hostname: config.host,

    async fetch(req, server) {
      const url = new URL(req.url);
      // Real client IP — check reverse proxy headers first
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || req.headers.get("x-real-ip")
        || server.requestIP(req)?.address
        || "unknown";

      // CORS preflight
      if (req.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }

      // Rate limiting (API endpoints only — snapshots serve cached files)
      if (url.pathname.startsWith("/api/")) {
        if (!checkRateLimit(ip)) {
          return withCors(new Response("Too many requests", { status: 429 }));
        }
      }

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, { data: { ip } });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }

      // Health check
      if (url.pathname === "/health") {
        return withCors(Response.json({
          state: sm.state,
          vehicles: currentVehicles.length,
          alerts: currentAlerts.length,
          clients: clientCount(),
          lastPoll: lastPollTimestamp,
        }));
      }

      // Snapshot listing
      if (url.pathname === "/data/snapshots") {
        const dates = listRecordingDates();
        log("debug", `Snapshot listing requested`, { dates });
        return withCors(Response.json(dates));
      }

      // Snapshot metadata (lightweight — no Parquet export)
      if (url.pathname.match(/^\/data\/snapshots\/\d{4}-\d{2}-\d{2}\/meta$/)) {
        const dateStr = url.pathname.slice("/data/snapshots/".length, -"/meta".length);
        const meta = await getSnapshotMeta(dateStr);
        if (!meta) {
          return withCors(new Response("Not found", { status: 404 }));
        }
        const resp = Response.json(meta);
        // Today's meta changes as data arrives; past dates are immutable
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
        resp.headers.set("Cache-Control", dateStr === today ? "no-cache" : "public, max-age=86400");
        return withCors(resp);
      }

      // Snapshot Parquet export (full day or time-range chunk)
      if (url.pathname.startsWith("/data/snapshots/")) {
        const dateStr = url.pathname.slice("/data/snapshots/".length);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return withCors(new Response("Invalid date format", { status: 400 }));
        }

        const fromParam = url.searchParams.get("from");
        const toParam = url.searchParams.get("to");

        let parquetPath: string | null;

        if (fromParam && toParam) {
          // Range-filtered chunk export
          const from = parseInt(fromParam, 10);
          const to = parseInt(toParam, 10);
          if (isNaN(from) || isNaN(to) || to <= from) {
            return withCors(new Response("Invalid from/to range", { status: 400 }));
          }
          parquetPath = await exportParquetRange(dateStr, from, to);
        } else {
          // Full day export (existing behaviour)
          parquetPath = await exportParquet(dateStr);
        }

        if (!parquetPath) {
          return withCors(new Response("Not found", { status: 404 }));
        }
        return withCors(new Response(Bun.file(parquetPath)));
      }

      // Route shape endpoint — returns full polyline with cumulative distances
      // Cache-Control: shapes don't change within a day
      if (url.pathname.startsWith("/api/route-shape/")) {
        const tripId = decodeURIComponent(url.pathname.slice("/api/route-shape/".length));
        const routeId = url.searchParams.get("routeId") ?? "";

        const shape = getShapeForTrip(tripId) ?? getShapeForRoute(routeId);

        if (!shape || shape.length === 0) {
          const resp = Response.json({ path: [], dists: [] });
          resp.headers.set("Cache-Control", "public, max-age=86400");
          return withCors(resp);
        }

        const path = shape.map((p) => [p.lon, p.lat] as [number, number]);
        const dists = shape.map((p) => p.dist);
        const resp = Response.json({ path, dists });
        resp.headers.set("Cache-Control", "public, max-age=86400");
        return withCors(resp);
      }

      // Serve client static files in production
      const clientDist = new URL("../../client/dist", import.meta.url).pathname;
      let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(clientDist + filePath);
      if (await file.exists()) {
        return new Response(file);
      }

      // SPA fallback: /replay/* routes are handled client-side
      if (url.pathname.startsWith("/replay/")) {
        return new Response(Bun.file(clientDist + "/index.html"));
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        const accepted = addClient(ws);
        if (!accepted) {
          ws.close(1008, "Too many connections from this IP");
          return;
        }

        // Send backlog + congestion snapshot so the client has
        // initial 10-min heatmap data without waiting to accumulate.
        if (sm.isBroadcasting && tickBacklog.length > 0) {
          const nowS = Math.floor(Date.now() / 1000);
          ws.send(JSON.stringify({
            type: "init",
            backlog: tickBacklog,
            congestion: getCongestion(nowS),
          }));
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

  // Notify connected clients before closing
  closeAllClients(1001, "Server shutting down");

  closeRecorder().catch(() => {});

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
