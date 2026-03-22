# Implementation Plan

Every step is small, has one goal, contains no code, and ends with a validation test.

The scaffolding is done. The code compiles. Nothing has been tested end-to-end. This plan takes the project from "it builds" to "it works."

---

## Phase 1 — Server can talk to the feed

### Step 1: Server boots and loads config

**Goal:** The server process starts, reads `.env`, and exits cleanly if the API key is missing.

**Validation:** Run `bun run dev:server` with a valid `.env`. Server logs `BOOT → INITIALIZING`. Remove `OPENDATA_VIC_API_KEY` from `.env`, restart — server logs `FATAL` and exits with code 1.

---

### Step 2: Protobuf schema loads

**Goal:** The server loads `gtfs-realtime.proto` and the `FeedMessage` type resolves.

**Validation:** Server logs `Protobuf schema loaded` during boot. If `proto/gtfs-realtime.proto` is deleted, server logs `FATAL` and exits.

---

### Step 3: Single feed fetch and decode

**Goal:** The server fetches one vehicle position feed (tram — smallest at ~20 KB) and decodes it into typed `VehiclePosition` objects.

**Validation:** Server logs `Decoded N vehicles from tram/vehicle-positions` where N > 0. Log one sample vehicle showing `entityId`, `latitude`, `longitude`, `routeId`.

---

### Step 4: All 10 feeds fetch and decode

**Goal:** All 10 feeds are fetched in parallel and decoded. Failures on individual feeds are logged but don't crash the server.

**Validation:** Server logs `Poll complete` with `vehicles > 0`, `tripUpdates > 0`, `alerts >= 0`, `succeeded: 10`, `failed: 0`. Temporarily break the bus URL — server still starts, logs 1 failed feed, `succeeded: 9`.

---

### Step 5: Poll loop runs on schedule

**Goal:** The poll cycle repeats every 15 seconds. Most polls return fresh data (feed caches ~30s, so every second poll has new data). Polls that return identical data are handled without errors.

**Validation:** Let the server run for 60 seconds. Count `Poll complete` log lines — should be ~8–9. Vehicle counts between consecutive polls should not swing more than 10% (vehicles enter/leave service gradually, not in bulk). No errors or uncaught exceptions.

---

## Phase 2 — Server produces correct world state

### Step 6: GTFS Schedule download and shape extraction

**Goal:** On first boot, the server downloads the GTFS Schedule ZIP (~191 MB), caches it, and extracts `shapes.txt` + `trips.txt` from each mode's sub-ZIP.

**Validation:** After boot, `.cache/gtfs/` contains `gtfs.zip` plus extracted files. Server logs `Shapes loaded` with `shapes > 1000` and `trips > 10000`. Second boot skips the download — logs `Using cached GTFS Schedule ZIP`.

---

### Step 7: Vehicles snap to shapes

**Goal:** Each vehicle position is matched to its GTFS shape via `trip_id → shape_id`, and its lat/lon is snapped onto the shape polyline.

**Validation:** Pick a known tram route (e.g. route 96, `route_id: aus:vic:vic-03-96:`). Log the raw feed lat/lon and the snapped lat/lon for one vehicle on that route. The snapped position must be within 50 meters of the tram tracks. Verify by computing haversine distance between raw and snapped — should be < 50m for a well-matched vehicle. Also log the `shapeId` to confirm it's non-empty.

---

### Step 8: Speed and bearing calculation

**Goal:** After two consecutive polls, the server calculates speed (m/s) and bearing (degrees) for each vehicle from position deltas along the shape.

**Validation:** Let the server run for 2+ polls (15+ seconds). Log a sample moving vehicle (one where position changed between polls) showing `speed` and `bearing`. Speed must be > 0 and ≤ the mode's max (33.3 m/s for metro/vline, 22.2 m/s for tram/bus — these are the caps in `interpolation/index.ts`). Bearing must be 0–360. For a tram with a matched shape: bearing must be non-zero even though the feed provides 0.

---

### Step 9: Stale vehicle detection

**Goal:** Vehicles with per-entity timestamps older than 120 seconds are flagged as `stale: true` and not interpolated.

**Validation:** Log the count of stale (`timestamp age > 120s`) vs active vehicles after a poll. During off-peak hours there will typically be stale vehicles (parked at depots), though during peak hours most may be fresh. The key test: pick any vehicle where `stale: true` — its position must not change between consecutive broadcast ticks. Its `speed` in the broadcast payload must be 0 or it must be excluded from interpolation.

---

### Step 10: Origin→target interpolation

**Goal:** Between polls, vehicles smoothly traverse from their previous position (origin) to their new position (target) along the shape, then project forward past the target.

**Validation:** Log 5 consecutive broadcast positions (5 ticks, ~5 seconds) for one moving, shape-matched vehicle. The distance between consecutive positions should be roughly equal (constant speed interpolation). No single tick should jump more than 2× the average step. All 5 positions should be within 30 meters of the vehicle's shape polyline (verify by computing snap distance). For a vehicle that received a new poll target mid-sequence: positions should smoothly approach the target, not teleport to it.

---

## Phase 3 — Server broadcasts to clients

### Step 11: WebSocket server accepts connections

**Goal:** The WebSocket endpoint at `/ws` accepts connections and sends an initial state payload.

**Validation:** `wscat -c ws://localhost:3000/ws` connects and immediately receives a JSON message containing `vehicles`, `alerts`, `timestamp`, and `serverState: "RUNNING"`.

---

### Step 12: Broadcast tick delivers world state

**Goal:** Connected WebSocket clients receive a new world state message approximately every 1 second.

**Validation:** Connect with `wscat`, count messages over 10 seconds — should be ~10 messages. Each message has a different `timestamp`. For any vehicle where `stale: false` and `speed > 0.5`: its `latitude` or `longitude` must differ between consecutive ticks (interpolation is advancing it). For any vehicle where `stale: true`: its position must be identical across ticks.

---

### Step 13: Multi-client consistency

**Goal:** Two WebSocket clients connected simultaneously receive identical vehicle positions.

**Validation:** Connect two `wscat` sessions. Compare the `timestamp` and first vehicle's lat/lon from the same tick on both — they should be identical.

---

### Step 14: Health endpoint

**Goal:** `GET /health` returns a JSON summary of server state.

**Validation:** `curl http://localhost:3000/health` returns JSON with `state: "RUNNING"`, `vehicles > 0`, `clients` count matching the number of connected WebSockets.

---

## Phase 4 — Client renders the map

### Step 15: Map loads with dark base layer

**Goal:** The client opens in a browser, initializes Mapbox GL JS with the dark-v11 style, and centers on Melbourne CBD.

**Validation:** Open `http://localhost:5173`. A dark map appears centered on Melbourne (-37.814, 144.963). The status bar shows "Loading map…" then "Connecting…".

---

### Step 16: WebSocket connects and receives data

**Goal:** The client connects to the server's WebSocket, receives tick data, and the store populates.

**Validation:** Open browser devtools console. The store's `worldState` is non-null. `worldState.vehicles.length` is > 0. Status bar shows "Live" with a green dot and vehicle count.

---

### Step 17: Vehicles render as arrows on the map

**Goal:** Vehicle positions from the WebSocket render as colored directional arrows on the map via the deck.gl IconLayer.

**Validation:** Arrows are visible on the map. Zoom into Melbourne CBD — tram arrows (green) should be visible along tram routes. Zoom out — bus arrows (orange) should cover wider Victoria. Arrows point in the direction of travel.

---

### Step 18: Arrows animate smoothly

**Goal:** Vehicle arrows glide along their routes between server ticks, using deck.gl transitions.

**Validation:** Watch a single tram for 30 seconds. It should move smoothly and continuously, not jump every 1 second. The movement should follow the road, not cut diagonally.

---

### Step 19: Snail trails render behind vehicles

**Goal:** A fading trail follows each moving vehicle, drawn by the PathLayer underneath the arrows.

**Validation:** Moving vehicles have visible colored trails behind them. Stationary vehicles (speed < 0.5 or stale) have no trail or a single-point trail. Trail color matches the vehicle's mode color (green for tram, blue for metro, etc.). The trail is a connected path of the vehicle's last 40 broadcast positions — at 1 tick/second, this represents ~40 seconds of movement history.

---

### Step 20: Tooltip on hover

**Goal:** Hovering over a vehicle arrow shows a tooltip with mode, route, vehicle ID, and tram class (if applicable).

**Validation:** Hover over a tram arrow — tooltip shows `TRAM`, route number (e.g. `96`), vehicle ID, and class (e.g. `B2`). Hover over a bus — shows `BUS`, route number, vehicle ID, no class. Hover over empty space — no tooltip.

---

## Phase 5 — Client handles edge cases

### Step 21: Reconnection on disconnect

**Goal:** If the WebSocket drops, the client automatically reconnects with exponential backoff. The status bar reflects the connection state.

**Validation:** Kill and restart the server while the client is open. Status bar shows "Reconnecting…" → "Connecting…" → "Waiting for data…" → "Live". Vehicles reappear. No page reload needed.

---

### Step 22: Stale state shown to user

**Goal:** If the WebSocket is alive but no ticks arrive for 5 seconds, the client shows a stale warning. Note: this is different from a disconnect — STALE means the connection is open but the server isn't sending data (e.g. server is in DEGRADED/STALE state itself, or the broadcast loop stalled).

**Validation:** This is hard to trigger naturally. To test: temporarily modify the server's `broadcastCycle` to skip sending (e.g. add an early return). The client WebSocket stays connected but receives no messages. After 5 seconds, the status bar changes to "Stale — waiting for update" with a yellow dot. Vehicles freeze on screen. Remove the modification — next tick arrives, status returns to "Live".

---

### Step 23: Manual reconnect from disconnected state

**Goal:** After max retries are exhausted, the status bar shows "Disconnected" with a reconnect button that works.

**Validation:** Stop the server. Wait for reconnect retries to exhaust (~30s). Status bar shows "Disconnected" with a "Reconnect" button. Start the server again. Click "Reconnect" — client reconnects and resumes.

---

### Step 24: Multi-window sync

**Goal:** Two browser windows open to the same URL show vehicles in the same positions at the same time.

**Validation:** Open two browser windows side by side. Zoom both to Melbourne CBD at the same zoom level. Both should show the same number of vehicles (check status bar count — must match). Pick a visible tram — its arrow should be at the same map position in both windows. The trails won't be pixel-identical (they depend on when each client connected) but the arrow heads should be, because the server broadcasts the same interpolated state to all clients on the same tick.

---

## Phase 6 — Polish

### Step 25: Service alert data available

**Goal:** Service alerts from the metro train and tram feeds are included in the world state and reachable from the client.

**Validation:** Open devtools console, inspect `worldState.alerts`. Should contain entries with `headerText` (e.g. "Buses replace trains between..."), `cause`, `effect`, and `informedEntities` with route IDs.

---

### Step 26: Error state on missing Mapbox token

**Goal:** If `VITE_MAPBOX_ACCESS_TOKEN` is missing, the client shows a clear error message instead of a blank screen.

**Validation:** Remove the token from `.env`, restart the client. The page shows "Error: Set VITE_MAPBOX_ACCESS_TOKEN in .env" — no blank screen, no console crash.

---

### Step 27: Production build runs

**Goal:** The built artifacts work correctly — server runs from `dist/`, client serves from `dist/`.

**Validation:** Run `bun run build`. Start the server with `bun run start` (from `packages/server`). The server must serve the client's static files from `packages/client/dist/` (or a reverse proxy must be configured to serve the client and proxy `/ws` to the server). Open in browser — map loads, vehicles move. This validates that the built artifacts work end-to-end. Note: the server currently only handles `/ws` and `/health` — serving static files or configuring a proxy is part of this step's implementation.

---

### Step 28: Docs site renders with Mermaid diagrams

**Goal:** The VitePress documentation site builds and all Mermaid diagrams render as interactive SVGs.

**Validation:** Run `bun run dev:docs`. Open the architecture page — the system flowchart renders as a diagram, not a code block. Open the data flow page — both poll cycle and broadcast cycle diagrams render. State machine diagrams render.

---

---

## Phase 7 — Time machine: server-side recording

### Step 29: DuckDB initializes on boot

**Goal:** When `RECORDING_ENABLED=true`, the server creates a DuckDB instance and a `snapshots` table in `.data/snapshots/YYYY-MM-DD.duckdb` on boot. When disabled, no DuckDB instance is created.

**Validation:** Set `RECORDING_ENABLED=true`, start server. `.data/snapshots/YYYY-MM-DD.duckdb` file exists where `YYYY-MM-DD` is today's date in `Australia/Melbourne` time (not the server's local timezone). Server logs confirming DuckDB initialized. Set `RECORDING_ENABLED=false`, restart — no `.duckdb` file created, no DuckDB-related logs.

---

### Step 30: Snapshots are recorded after each poll

**Goal:** After each `processSnapshot()`, the enriched `VehiclePosition[]` is batch-inserted into the DuckDB `snapshots` table. Recording does not block poll/broadcast.

**Validation:** Run server with recording enabled for 2 minutes. Open the `.duckdb` file with the `duckdb` CLI. `SELECT COUNT(*) FROM snapshots` returns > 0. `SELECT COUNT(DISTINCT timestamp) FROM snapshots` returns ~4 (2 min ÷ ~30s feed refresh, duplicates skipped). `SELECT DISTINCT mode FROM snapshots` returns `metro`, `tram`, `bus`, `vline`.

---

### Step 31: Retention cleanup

**Goal:** On startup, `.duckdb` files in the data directory older than `RECORDING_RETENTION_DAYS` are deleted.

**Validation:** Create a dummy `.duckdb` file with a date 60 days ago. Set `RECORDING_RETENTION_DAYS=30`, start server. The old file is deleted. Today's file is kept.

---

### Step 32: Parquet export endpoint

**Goal:** `GET /data/snapshots/:date` exports that day's DuckDB data as a Parquet file. `GET /data/snapshots` lists available dates.

**Validation:** Record for 5 minutes. `curl http://localhost:3000/data/snapshots` returns a JSON array containing today's date. `curl http://localhost:3000/data/snapshots/YYYY-MM-DD -o day.parquet` downloads a file. Open with `duckdb` CLI: `SELECT COUNT(*) FROM 'day.parquet'` returns rows matching the DuckDB table count.

---

## Phase 8 — Time machine: client-side playback

### Step 33: DuckDB-WASM loads a Parquet file

**Goal:** The client can fetch a Parquet export from the server and open it with DuckDB-WASM in the browser.

**Validation:** Open devtools console. Manually trigger a fetch of `/data/snapshots/YYYY-MM-DD`, load into DuckDB-WASM, run `SELECT COUNT(*) FROM snap`. Returns > 0.

---

### Step 34: Date picker and time slider

**Goal:** A date picker lets the user select a recorded day. A time slider (scrubber bar) at the bottom of the screen controls the playback timestamp.

**Validation:** Date picker shows only dates that have recordings (from `/data/snapshots` endpoint). Selecting a date loads the Parquet file. The time slider range is the min/max timestamp in the file. Dragging the slider updates a displayed time-of-day label.

---

### Step 35: Playback feeds the rendering pipeline

**Goal:** Dragging the time slider queries DuckDB-WASM for vehicle positions at that timestamp, constructs a `WorldState`, and feeds it to `applyTick()`. Vehicles appear at their historical positions on the map.

**Validation:** Drag the slider to a rush-hour timestamp. ~2,000 arrows appear. Drag to 3am. Far fewer arrows. Arrows are positioned on roads/tracks (same shape data used for live rendering). Trails build as the slider moves forward.

---

### Step 36: Live/playback mode toggle

**Goal:** The client toggles between live mode (WebSocket) and playback mode (DuckDB-WASM). They are mutually exclusive — entering playback pauses the WebSocket; returning to live reconnects it.

**Validation:** In live mode, vehicles move in real time. Click "History" → select a date → live WebSocket pauses, playback slider appears. Click "Live" → slider disappears, WebSocket reconnects, real-time data resumes. No page reload.

---

### Step 37: Animated playback with speed control

**Goal:** A play button auto-advances the time slider. Speed controls: 1×, 10×, 60×, 360× (1 second of wall clock = 1/10/60/360 seconds of historical time).

**Validation:** Hit play at 1×. Vehicles move at real-time speed across the map. Switch to 360×. A full 24-hour day completes in ~4 minutes. The morning rush is visible as a burst of arrows. Pause works. Scrubbing during playback stops auto-advance.

---

## Done criteria

Steps 1–28 are the core system. Steps 29–37 are the time machine.

**Core done (steps 1–28):** Boots from cold start, produces smooth road-following positions, broadcasts to synced clients, renders ~2,000 moving arrows with trails, handles edge cases, builds for production, docs work.

**Time machine done (steps 29–37):** Server records every poll to DuckDB, exports daily Parquet files, client loads them with DuckDB-WASM, date picker + time slider + speed controls let you scrub through and timelapse any recorded day.
