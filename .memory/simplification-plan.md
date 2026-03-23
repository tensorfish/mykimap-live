# Simplification Plan

Deep dive findings. 3,742 lines across server + client. Here's what's dead, redundant, or overcomplicated.

---

## Dead code to remove

### 1. Server-side trails (`vehicleTrails`, `appendTrail`, `getTrails`) — ~40 lines

The client generates its own trails from the animation system. The server still computes and sends `trails` in every `WorldState` broadcast — the client ignores them. Remove the trail tracking from the server entirely. Remove `trails` from `WorldState`.

### 2. Server-side `pathSegment` generation — ~30 lines

The client does its own route-based animation via `clientSnapToShape` + shape cache. The `pathSegment` field in `VehiclePosition` (server generates route geometry between ticks) is never used by the client. Remove `pathSegment` from `VehiclePosition`, remove `sampleShapeSegment` calls from `interpolate()`, remove `lastBroadcastDist` tracking.

### 3. `prevShapeDistTraveled` — ~10 lines

Added for the old animation system to compute initial speed. The new target-queue model doesn't use it. Remove from `VehiclePosition`, `decoder.ts`, `processSnapshot`, and client types.

### 4. `InitialState` type — ~10 lines

The `backlog` message already contains everything. `InitialState` has separate `alerts` and `trails` fields, but `trails` is dead (see #1) and `alerts` are in the last backlog tick's `WorldState`. Remove the type. Send backlog as `{ type: "init", backlog: WorldState[] }`.

### 5. Server-side `bearingAtDist` — ~15 lines

Only used in `interpolate()` for the delayed playback. But the client computes its own bearing from shape geometry. The server's bearing calculation is redundant — the client overrides it anyway. Can simplify to just passing through the raw feed bearing.

### 6. `sampleShapeSegment` in `shapes/snap.ts` — ~35 lines

Only called from server `interpolate()` to generate `pathSegment`. Since `pathSegment` is dead (#2), this function is dead.

---

## Server simplification

### Current: 319-line `interpolation/index.ts`

The server does:
1. Buffer snapshots (30s delayed playback)
2. Snap to shapes + pick direction
3. Generate trails
4. Interpolate between snapshots
5. Generate path segments
6. Track per-vehicle bearing/speed

**After removing dead code (#1-6), it becomes:**
1. Buffer snapshots (keep — this is the delayed playback)
2. Snap to shapes + pick direction (keep — needed for accurate positions)
3. Interpolate between snapshots (keep — core server function)

The interpolation can be simplified: remove path segment generation, remove trail generation, remove `lastBroadcastDist`. Just lerp shapeDist between two snapshots and sample the position. ~150 lines instead of 319.

### Current: 164-line `types.ts`

Remove `pathSegment`, `prevShapeDistTraveled` from `VehiclePosition`. Remove `trails` from `WorldState`. Remove `InitialState` type. ~130 lines.

---

## Client simplification

### Current: 429-line `layers.ts`

This is the largest file and the core of the animation system. It's already been rewritten to the target-queue model. The remaining complexity is justified:
- Shape cache + fetching (~60 lines) — needed
- `clientSnapToShape` (~20 lines) — needed for playback
- Animation state + queue (~40 lines) — core logic
- `computeFrame` with easing (~70 lines) — core logic
- Trail (~30 lines) — core logic
- Three layer creators (~100 lines) — rendering

No major simplification possible without removing features.

### Current: 278-line `playback.ts`

DuckDB-WASM init, download with progress, parse into memory. Most of this is inherent complexity. Could extract the DuckDB init + download into a `duckdb-loader.ts` for clarity, but the line count wouldn't change.

### Current: 144-line `store.ts`

Has `fetchRouteShape` (async fetch + store update) mixed in with pure state management. Could move route shape fetching to `layers.ts` (where the shape cache already lives). ~20 lines moved.

---

## Protocol simplification

### Current WebSocket messages:

```
init: { type: "init", backlog: WorldState[], alerts, trails, serverState }
tick: { type: "tick", ...WorldState }
```

`WorldState` carries `trails` (dead), `pathSegment` per vehicle (dead), `prevShapeDistTraveled` (dead).

### Simplified:

```
init: { type: "init", backlog: VehicleTick[] }
tick: { type: "tick", ...VehicleTick }

VehicleTick = {
  timestamp: number;
  vehicles: SimpleVehicle[];
  alerts: ServiceAlert[];
  serverState: ServerState;
  seq: number;
}

SimpleVehicle = {
  entityId, mode, tripId, routeId, vehicleId, vehicleLabel,
  latitude, longitude, bearing, speed, timestamp, stale,
  shapeDistTraveled, shapeId, startTime, startDate
}
```

No `trails`, no `pathSegment`, no `prevShapeDistTraveled`. ~40% smaller payload per tick.

---

## Estimated impact

| Area | Before | After | Saved |
|---|---|---|---|
| `interpolation/index.ts` | 319 | ~180 | 139 lines |
| `types.ts` | 164 | ~130 | 34 lines |
| `shapes/snap.ts` | 168 | ~130 | 38 lines |
| WS payload per tick | ~400 KB | ~240 KB | ~40% bandwidth |
| Total server | 2,119 | ~1,900 | ~220 lines |

Client stays roughly the same — the complexity there is justified.

---

## What NOT to change

- Shape loading (`loader.ts`) — works, tested, complex but necessary
- Polling + decoding (`poller/`) — clean, no dead code
- DuckDB recording (`recorder/`) — works, minimal
- Client animation (`layers.ts`) — just rewritten, target-queue model is clean
- State machine — simple, works
- Config — works

---

## Execution order

1. Remove `pathSegment` from `VehiclePosition` + all generation code
2. Remove `prevShapeDistTraveled` from `VehiclePosition`
3. Remove server-side trails (`vehicleTrails`, `appendTrail`, `getTrails`)
4. Remove `trails` from `WorldState`
5. Remove `InitialState` type, simplify init message
6. Remove `sampleShapeSegment` from `shapes/snap.ts`
7. Clean up client types to match
8. Verify build + test
