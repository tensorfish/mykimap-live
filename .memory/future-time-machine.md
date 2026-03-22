# Future: Time Machine (Route Playback)

Status: **Not implemented.** This document defines the feature and the architectural seams that must exist to support it.

---

## What it is

A time slider on the map that lets you scrub through historical vehicle positions. Drag left to watch the morning rush build. Hit play to watch an entire day compress into 60 seconds — 2,000 arrows streaming through the city, trails painting the network's pulse.

## Why it matters

The live map is interesting for 30 seconds. A time-lapse of an entire city's transport network is something people come back to, share, and stare at. It also makes the tool useful beyond enthusiasm — transport planners see bottlenecks, journalists replay incidents, researchers study patterns.

## Data budget

| Metric | Value |
|---|---|
| Snapshot size | ~2,000 vehicles × ~100 bytes ≈ 200 KB |
| Snapshots per day | ~12,300 (one per 7s poll) |
| Raw daily volume | ~2.4 GB |
| Delta-compressed | Estimated < 500 MB/day (most vehicles don't move between consecutive 7s polls) |

## Architecture

### Server: snapshot recording

The server already decodes and enriches every poll result into a `PollResult` (see `poller/index.ts`). The recording hook goes here — after decode, before interpolation.

**Seam point:** `pollCycle()` in `index.ts`. After `processSnapshot()` returns, the snapshot is complete and enriched (snapped positions, speed, bearing). This is where a recorder would persist it.

```
pollCycle()
  → poll()                    # fetch + decode
  → processSnapshot()         # snap, speed, bearing
  → recorder.write(snapshot)  # ← FUTURE: persist to disk
  → broadcast continues as normal
```

The recorder must:
- Write each snapshot with its `headerTimestamp` as the key
- Write to local disk, not a remote service — one Parquet file per day
- Be non-blocking — poll/broadcast must not wait on disk I/O
- Be optional — if recording is disabled, zero overhead

**File format:** Parquet. Each row is one vehicle at one timestamp. Columns: `timestamp`, `entityId`, `mode`, `routeId`, `latitude`, `longitude`, `bearing`, `speed`, `stale`. Parquet gives columnar compression (great for the many-identical-positions-between-polls case) and is directly queryable by DuckDB.

**Storage path:** `.data/snapshots/YYYY-MM-DD.parquet`

### Client: DuckDB-powered playback

The client downloads the Parquet file for a requested day and queries it locally using [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview). No server-side query engine needed.

**Why DuckDB-WASM on the client:**
- Parquet files are static — serve from any CDN or the server's `/data` endpoint
- DuckDB-WASM runs entirely in the browser, queries Parquet directly
- Range queries are fast: `SELECT * FROM 'day.parquet' WHERE timestamp BETWEEN x AND y`
- No server load for playback — scales to unlimited concurrent viewers
- The server stays simple (just writes files)

**Playback flow:**
1. User picks a date → client fetches `/data/snapshots/2026-03-22.parquet` (or range of partial files)
2. DuckDB-WASM opens the file in the browser
3. Time slider controls a `playbackTimestamp`
4. On each animation frame, query: `SELECT * FROM snap WHERE timestamp = closest(playbackTimestamp)`
5. Feed the result into the same store → same layers render it
6. The store already accepts a `WorldState` via `applyTick()` — playback just supplies synthetic ticks

**Key constraint:** The `applyTick()` function and the entire rendering pipeline (store → layers → deck.gl) must not care whether the data came from a live WebSocket tick or a historical DuckDB query. Same `WorldState` shape, same code path.

### What must be true in the current architecture

These are the seams. If any of these are violated, the time machine becomes a rewrite instead of an addition.

1. **`PollResult` is a pure data object.** It has no side effects, no WebSocket references, no timers. It can be serialized to disk. ✅ Already true.

2. **`processSnapshot()` is a pure function of (vehicles, headerTimestamp).** It reads from `vehicleStates` (internal mutable map) but the output is a standalone array. The snapshot after processing is self-contained. ✅ Already true — the output `VehiclePosition[]` has everything needed to render.

3. **`WorldState` is the single interchange format between server and client.** Both live broadcast and future playback must produce the same shape. ✅ Already true.

4. **`applyTick()` in the client store accepts any `WorldState` regardless of source.** ✅ Already true — it just sets the state.

5. **The client rendering pipeline has no dependency on WebSocket liveness.** Layers render from store state, not from the connection. ✅ Already true — if you call `applyTick()` manually from devtools, it renders.

6. **The server's `/health` or a new `/data` endpoint can serve static Parquet files.** ⚠️ Not yet implemented but trivial to add — Bun.serve can serve static files from a directory.

### What must NOT change

- `WorldState` type shape — adding fields is fine, removing/renaming is not
- `applyTick()` signature — it must keep accepting a `WorldState`
- `PollResult` must remain serializable (no functions, no circular refs)
- The store must remain the single source of truth for what's on screen

---

## Implementation phases (future)

### Phase A: Server-side recording
- Add `recorder/` module to server
- Write enriched snapshots to `.data/snapshots/YYYY-MM-DD.parquet` after each poll
- Add `RECORDING_ENABLED` env var (default: false)
- Add `/data/snapshots/:filename` static file endpoint
- No client changes

### Phase B: Client-side playback
- Add `duckdb-wasm` to client dependencies
- Add date picker + time slider UI
- Add playback engine: load Parquet → query by timestamp → feed `applyTick()`
- Toggle between live mode and playback mode (mutually exclusive — live WS disconnects during playback)
- Trail rendering works automatically (store already tracks positions)

### Phase C: Day compression
- "Play day" button: compress 24h into 60s (or user-controlled speed)
- Playback speed: 1×, 10×, 60×, 360× (1 second = 1 hour)
- Progress bar showing time-of-day
