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
| Interpolation | Custom module | Between polls (every 7s), vehicles traverse from their previous known position (origin) to their latest known position (target) along the matched GTFS shape polyline. After reaching the target, they project forward using calculated speed. Falls back to straight-line lerp/projection when no shape is matched. |
| Shared clock | Server-authoritative tick | The server stamps every broadcast with a canonical timestamp. All clients animate from the same reference point, so multiple open windows show vehicles in the same place. |

### Data flow

1. **Poll** — Every 7 seconds, fetch all 10 feeds in parallel (4 vehicle positions + 4 trip updates + 2 service alerts). Auth via `KeyID` header. ~558 KB per poll. Feed caches ~30s server-side so most polls return identical data — but we catch changes within 7s of them appearing.
2. **Snapshot** — Decode protobuf. Snap each vehicle onto its GTFS route shape polyline (matched via `trip_id` → `shape_id` from static GTFS Schedule). Calculate speed from distance traveled along the shape. Merge trip updates and service alerts.
3. **Interpolate** — Between polls, advance each vehicle along its shape polyline by `speed × dt`. Vehicles follow the actual road/track/tram line geometry — never cut through buildings. Falls back to straight-line projection for vehicles without a matched shape. Skip stale vehicles (per-vehicle timestamp > 120s old).
4. **Broadcast** — Every ~1s, push the interpolated state to all connected clients over WebSocket.

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

- **No framework.** Vanilla TypeScript with direct DOM manipulation for UI, TanStack Store for reactivity, deck.gl pure JS API for the map layer.
- **Arrows**: Vehicles are rendered as a deck.gl `IconLayer` with a canvas-generated arrow icon, rotated by `getAngle` to match bearing. White arrow tinted per-mode via `getColor`. Stale vehicles render dimmed gray.
- **Trails**: A `PathLayer` renders underneath the arrows, drawing each vehicle's recent position history as a colored path. The store tracks the last 40 positions per vehicle. Trails use the same mode color at reduced opacity.
- The store subscription triggers `deck.setProps()` with both layers whenever world state changes. The `IconLayer` uses deck.gl's built-in `transitions` on `getPosition` and `getAngle` for smooth 1s animation between server ticks.
- **Mode colors**: blue (metro `[52,172,225]`), green (tram `[120,190,32]`), orange (bus `[255,130,0]`), purple (V/Line `[165,127,178]`).
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

## What's intentionally absent

- **No database.** Vehicle state is ephemeral — it lives in memory on the server and is replaced every poll.
- **No REST API.** All client-server communication is WebSocket.
- **No authentication.** This is a public visualisation tool.
- **No UI framework.** Vanilla TS + TanStack Store + direct DOM. No React, no virtual DOM.

## Data Constraints (from live feed analysis)

These shape the server's interpolation design:

- **No speed on any feed.** Must be derived from consecutive position deltas.
- **No bearing on trams.** Must be inferred from consecutive lat/lon changes. Trains, buses, and V/Line do provide bearing.
- **Per-vehicle freshness varies wildly** within a single snapshot (10s to 15min). Stale vehicles are likely parked — do not interpolate them.
- **Feed caches for ~30s server-side.** Polling faster is wasted.
- **~2,000 vehicles total** across 4 position feeds. Bus dominates (~1,700).
- **Trip updates use absolute times**, not delay offsets. `arrival.delay` is always 0 — use `arrival.time` instead.
- **Service alerts exist for train and tram only** — no bus or V/Line alerts.
- **GTFS Schedule** (~191 MB static ZIP) provides route names, colors, stop names, and 3.7M shape points for route geometry.

See [gtfs-vic.md](gtfs-vic.md) for the full field-by-field breakdown.
