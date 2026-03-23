# Tech Stack

## Runtime

**Bun** — used everywhere: server, client tooling, package management, script running, and workspace orchestration.

## Project Structure

```
packages/
  server/         → Backend service
    src/
      poller/       Feed fetching + protobuf decoding
      shapes/       GTFS Schedule loader, shape index, polyline snapping
      interpolation/ Origin→target traversal along shapes, geo math
      broadcast/    WebSocket client management
    proto/          gtfs-realtime.proto schema
  client/         → Map frontend (vanilla TS, no framework)
    src/            Store, WebSocket, map, layers, icons, UI
docs/             → VitePress documentation site
.cache/gtfs/      → Cached GTFS Schedule ZIP + extracted files (gitignored)
```

Bun workspaces manage all three from the root.

## Server (`packages/server`)

**Purpose:** Poll the GTFS Realtime feed, interpolate vehicle positions between polls, and broadcast a consistent world state to every connected frontend.

### Core pieces

| Concern | Choice | Why |
|---|---|---|
| HTTP + WebSocket | Bun's built-in server (`Bun.serve`) | Native, fast, no extra deps. WebSocket support is first-class. |
| GTFS Realtime decoding | `protobufjs` | GTFS-RT is a Protocol Buffer format. Decode 10 feeds per poll (~558 KB combined): 4 vehicle positions, 4 trip updates, 2 service alerts. |
| Route shapes | Custom `shapes/` module | Downloads GTFS Schedule ZIP (~191 MB) on first boot, caches in `.cache/gtfs/`, extracts `shapes.txt` + `trips.txt` to build an in-memory `trip_id → shape polyline` index. Non-fatal if download fails — falls back to straight-line interpolation. |
| Interpolation | Custom module | 30s delayed playback — interpolates between two known poll positions along the shape. No prediction. See [animation-architecture.md](animation-architecture.md). |
| Recording | `recorder/` module | DuckDB records raw feed data on every fresh poll. Exports to Parquet for historical playback. Enabled by default. |
| Shared clock | Server-authoritative tick | The server stamps every broadcast with a canonical timestamp. All clients animate from the same reference point, so multiple open windows show vehicles in the same place. |

### Data flow

1. **Poll** — Every 15 seconds, fetch all 10 feeds in parallel. Auth via `KeyID` header. ~558 KB per poll. Feed caches ~30s server-side.
2. **Record** — Raw feed data saved to DuckDB (`.data/snapshots/YYYY-MM-DD.duckdb` in Melbourne time) before processing.
3. **Snapshot** — Decode protobuf. Snap each vehicle onto its GTFS route shape polyline (dual-direction per route). Calculate speed from shape distance delta.
4. **Interpolate** — 30s delayed playback: interpolate between two known snapshots along the shape. Every broadcast position is between two ground-truth points — no prediction, no overshoot.
5. **Broadcast** — Every ~1s, push interpolated state to all connected clients via WebSocket.

### Multi-client consistency

Every frontend receives the same broadcast at the same server tick. Clients don't independently guess positions — they render exactly what the server sends. If you open two browser tabs, the trams are in the same spot on both.

## Client (`packages/client`)

**Purpose:** Render thousands of moving vehicles on a map with smooth animation.

### Core pieces

| Concern | Choice | Why |
|---|---|---|
| Build tool | Vite | Fast dev server, works well with Bun. |
| Map base layer | Mapbox GL JS (`mapbox-gl`) | High-quality vector tiles, smooth pan/zoom, dark/light styles. |
| Data layer | deck.gl (pure JS API) | GPU-accelerated rendering. Handles tens of thousands of animated points without dropping frames. No framework wrapper needed. |
| State | TanStack Store (`@tanstack/store`) | Lightweight reactive store. Subscribe to changes, update deck.gl layers and DOM directly. No virtual DOM overhead. |
| WebSocket client | Native browser WebSocket | Connects to the server, receives tick updates, pushes into the store. |

### Rendering approach

See [animation-architecture.md](animation-architecture.md) for the full animation system.

- **No framework.** Vanilla TypeScript, TanStack Store, deck.gl pure JS API.
- **Single render loop** at 60fps — handles both live and playback, no duplicate animation code.
- **Route-based animation** — each vehicle animates along its cached GTFS route shape. Position, bearing, and trail are all sampled from the shape geometry.
- **Arrows**: deck.gl `IconLayer` with canvas-generated arrow icon. Bearing from shape direction at current position.
- **Trails**: deck.gl `PathLayer` — 800m slice of the route shape behind the arrow. Trail tail follows the arrow; "eats itself" when the arrow stops.
- **Client-side shape snapping** — for playback data (raw GPS with no `shapeDistTraveled`), the client snaps lat/lon to the cached route shape.
- **Speed multiplier** — one function controls animation speed: live=1, playback=speed, paused=0.
- **Mode colors**: blue (metro), green (tram), orange (bus), purple (V/Line).
- **Arrow sizes** (pixels): metro 28, tram 22, bus 14, V/Line 28.

## Docs (`docs/`)

| Concern | Choice |
|---|---|
| Static site generator | VitePress |
| Content | Internal documentation — architecture, data flow, setup guides |
| Changelog | Maintained in `docs/changelog.md`, rendered as a page |

## Key Dependencies Summary

| Package | Used in | Purpose |
|---|---|---|
| `protobufjs` | server | Decode GTFS Realtime protobuf (10 feeds, ~2,000 vehicles, ~558 KB/poll) |
| `mapbox-gl` | client | Base map tiles |
| `deck.gl` | client | GPU-accelerated vehicle rendering (pure JS API) |
| `@tanstack/store` | client | Reactive state — drives layer updates and UI |
| `vite` | client | Dev server and bundler |
| `vitepress` | docs | Documentation site |
| `duckdb` | server | Record raw feed snapshots, export to Parquet |
| `@duckdb/duckdb-wasm` | client | Load and query Parquet for historical playback |

## What's intentionally absent

- **DuckDB on both sides.** Server records raw feed data to daily `.duckdb` files (enabled by default). Client loads Parquet exports via DuckDB-WASM for historical playback.
- **REST endpoints** for playback: `GET /data/snapshots` lists dates, `GET /data/snapshots/:date` exports Parquet, `GET /api/route-shape/:tripId` returns route geometry.
- **No authentication.** This is a public visualisation tool.
- **No UI framework.** Vanilla TS + TanStack Store + direct DOM. No React, no virtual DOM.

## Architectural seams (must preserve)

These invariants exist to support the future time machine feature. Do not violate them.

1. **`PollResult` is a pure serializable data object.** No side effects, no socket references. It can be written to disk.
2. **`WorldState` is the single interchange format.** Both live WebSocket ticks and future historical playback must produce the same shape.
3. **`applyTick()` accepts any `WorldState` regardless of source.** The rendering pipeline must not care whether data is live or replayed.
4. **Client rendering has no dependency on WebSocket liveness.** Layers render from store state, not from the connection.

## Data Constraints (from live feed analysis)

These shape the server's interpolation design:

- **No speed on any feed.** Must be derived from consecutive position deltas.
- **No bearing on trams.** Must be inferred from consecutive lat/lon changes. Trains, buses, and V/Line do provide bearing.
- **Per-vehicle freshness varies wildly** within a single snapshot (10s to 15min). Stale vehicles are likely parked — do not interpolate them.
- **Feed caches for ~30s server-side.** At 15s polls, every other poll returns fresh data.
- **~2,000 vehicles total** across 4 position feeds. Bus dominates (~1,700).
- **Trip updates use absolute times**, not delay offsets. `arrival.delay` is always 0 — use `arrival.time` instead.
- **Service alerts exist for train and tram only** — no bus or V/Line alerts.
- **GTFS Schedule** (~191 MB static ZIP) provides route names, colors, stop names, and 3.7M shape points for route geometry.

See [gtfs-vic.md](gtfs-vic.md) for the full field-by-field breakdown.
