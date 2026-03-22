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

**Goal:** The poll cycle repeats every 7 seconds. Consecutive polls that return identical data (feed cache hasn't refreshed) are handled without errors.

**Validation:** Let the server run for 60 seconds. Count `Poll complete` log lines — should be ~8–9. Vehicle counts should be stable (±20 between polls as vehicles enter/leave service). No errors.

---

## Phase 2 — Server produces correct world state

### Step 6: GTFS Schedule download and shape extraction

**Goal:** On first boot, the server downloads the GTFS Schedule ZIP (~191 MB), caches it, and extracts `shapes.txt` + `trips.txt` from each mode's sub-ZIP.

**Validation:** After boot, `.cache/gtfs/` contains `gtfs.zip` plus extracted files. Server logs `Shapes loaded` with `shapes > 1000` and `trips > 10000`. Second boot skips the download — logs `Using cached GTFS Schedule ZIP`.

---

### Step 7: Vehicles snap to shapes

**Goal:** Each vehicle position is matched to its GTFS shape via `trip_id → shape_id`, and its lat/lon is snapped onto the shape polyline.

**Validation:** Pick a known tram route (e.g. route 96). Log the raw feed lat/lon and the snapped lat/lon for one vehicle on that route. The snapped position should be on or very near the tram tracks (verify by pasting both coordinates into Google Maps).

---

### Step 8: Speed and bearing calculation

**Goal:** After two consecutive polls, the server calculates speed (m/s) and bearing (degrees) for each vehicle from position deltas along the shape.

**Validation:** Let the server run for 2+ polls. Log a sample vehicle showing `speed` (should be 0–33 m/s for trains, 0–22 for buses) and `bearing` (0–360). Trams should have non-zero bearing (inferred from shape) despite the feed providing 0.

---

### Step 9: Stale vehicle detection

**Goal:** Vehicles with per-entity timestamps older than 120 seconds are flagged as `stale: true` and not interpolated.

**Validation:** Log the count of stale vs active vehicles after a poll. There should always be some stale vehicles (parked at depots). Verify a stale vehicle has `speed: 0` and doesn't move between broadcasts.

---

### Step 10: Origin→target interpolation

**Goal:** Between polls, vehicles smoothly traverse from their previous position (origin) to their new position (target) along the shape, then project forward past the target.

**Validation:** Log 5 consecutive broadcast positions for one moving vehicle. Positions should form a smooth progression along the route — not a sudden jump to the target. Paste the 5 coordinates into Google Maps — they should all fall on the road/track.

---

## Phase 3 — Server broadcasts to clients

### Step 11: WebSocket server accepts connections

**Goal:** The WebSocket endpoint at `/ws` accepts connections and sends an initial state payload.

**Validation:** `wscat -c ws://localhost:3000/ws` connects and immediately receives a JSON message containing `vehicles`, `alerts`, `timestamp`, and `serverState: "RUNNING"`.

---

### Step 12: Broadcast tick delivers world state

**Goal:** Connected WebSocket clients receive a new world state message approximately every 1 second.

**Validation:** Connect with `wscat`, count messages over 10 seconds — should be ~10 messages. Each message has a different `timestamp`. Vehicle positions should change slightly between consecutive messages (interpolation working).

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

**Validation:** Moving vehicles have visible colored trails behind them. Stationary vehicles have no trail. The trail follows the route — not a straight line. Trails are shorter when zoomed in, longer when zoomed out.

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

**Goal:** If the server stops broadcasting (e.g. all feeds fail), the client shows a stale warning after 5 seconds.

**Validation:** Stop the server. After 5 seconds, status bar changes to "Stale — waiting for update" with a yellow dot. Vehicles freeze on screen.

---

### Step 23: Manual reconnect from disconnected state

**Goal:** After max retries are exhausted, the status bar shows "Disconnected" with a reconnect button that works.

**Validation:** Stop the server. Wait for reconnect retries to exhaust (~30s). Status bar shows "Disconnected" with a "Reconnect" button. Start the server again. Click "Reconnect" — client reconnects and resumes.

---

### Step 24: Multi-window sync

**Goal:** Two browser windows open to the same URL show vehicles in the same positions at the same time.

**Validation:** Open two browser windows side by side. Zoom both to the same area. Pick a moving vehicle — its position and trail should be visually identical in both windows.

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

**Validation:** Run `bun run build`. Start the server with `bun run start` (from `packages/server`). Serve `packages/client/dist/` with any static file server. Open in browser — map loads, vehicles move.

---

### Step 28: Docs site renders with Mermaid diagrams

**Goal:** The VitePress documentation site builds and all Mermaid diagrams render as interactive SVGs.

**Validation:** Run `bun run dev:docs`. Open the architecture page — the system flowchart renders as a diagram, not a code block. Open the data flow page — both poll cycle and broadcast cycle diagrams render. State machine diagrams render.

---

## Done criteria

All 28 steps pass their validation tests. The system:

- Boots from cold start (downloads GTFS, loads shapes, polls feeds)
- Produces smooth, road-following vehicle positions
- Broadcasts to multiple clients in sync
- Renders ~2,000 moving arrows with trails on a dark map
- Handles disconnects, stale data, and missing config gracefully
- Builds for production
- Has working documentation
