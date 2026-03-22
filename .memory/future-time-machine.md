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
| Rows per day | ~24.6M (2,000 vehicles × 12,300 snapshots) |
| Raw daily volume | ~2.4 GB |
| DuckDB compressed | Estimated < 300 MB/day (columnar compression, many repeated positions between 7s polls) |

---

## Architecture: DuckDB everywhere

DuckDB on both sides. Server writes. Client reads. Same engine, same query language, same data format.

### Server: DuckDB recording

The server runs a local DuckDB instance. After each poll cycle, it inserts the enriched snapshot into a table. One database file per day, auto-rotated at midnight.

**Seam point:** `pollCycle()` in `index.ts`. After `processSnapshot()` returns, the snapshot is complete and enriched (snapped positions, speed, bearing). This is where the recorder inserts.

```
pollCycle()
  → poll()                    # fetch + decode
  → processSnapshot()         # snap, speed, bearing
  → recorder.insert(snapshot) # ← insert into DuckDB
  → broadcast continues as normal
```

**DuckDB server-side details:**

- **Library:** `duckdb` (Node-API bindings, works with Bun)
- **Storage:** `.data/snapshots/YYYY-MM-DD.duckdb` — one file per day, where `YYYY-MM-DD` is the date in **`Australia/Melbourne`** timezone (not the server's local time, not UTC). This matches how PTV operates — their schedules, service days, and timetables all use Melbourne time.
- **Date derivation:** `new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' })` → `"2026-03-22"`. The `en-CA` locale gives `YYYY-MM-DD` format.
- **Day boundary:** Midnight Melbourne time. A poll at 23:59 AEST goes into today's file; a poll at 00:01 AEST goes into tomorrow's.
- **Table schema:**

```sql
CREATE TABLE snapshots (
  timestamp  UINTEGER,     -- POSIX seconds
  entity_id  VARCHAR,
  mode       VARCHAR,       -- 'metro', 'tram', 'bus', 'vline'
  route_id   VARCHAR,
  vehicle_id VARCHAR,
  latitude   FLOAT,
  longitude  FLOAT,
  bearing    FLOAT,
  speed      FLOAT,
  stale      BOOLEAN,
  shape_dist FLOAT
);
```

- **Write strategy:** Batch insert after each poll — one `INSERT INTO snapshots VALUES (?, ?, ...), (?, ?, ...), ...` with ~2,000 rows. DuckDB handles this in < 10ms.
- **Non-blocking:** The insert is fire-and-forget with error logging. Poll/broadcast must not wait on slow disk.
- **Optional:** Controlled by `RECORDING_ENABLED` env var (default: `false`). When disabled, no DuckDB instance is created, zero overhead.
- **Retention:** Configurable via `RECORDING_RETENTION_DAYS` env var (default: `30`). On startup, delete `.duckdb` files older than the threshold.
- **Export endpoint:** `GET /data/snapshots/:date` exports a day's data as Parquet for the client to download. DuckDB does this natively: `COPY (SELECT * FROM snapshots) TO '/tmp/export.parquet' (FORMAT PARQUET)`.

### Client: DuckDB-WASM playback

The client downloads a Parquet export for a requested day and queries it locally using [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview). All playback queries run in the browser — no server load.

**Why DuckDB on both sides:**
- Server uses DuckDB for append-heavy time-series writes (columnar, compressed, fast batch inserts)
- Client uses DuckDB-WASM to query the same data with the same SQL
- Export is a single `COPY TO PARQUET` — no custom serialization
- Parquet files are static once exported — cacheable by CDN or browser

**Playback flow:**
1. User picks a date → client fetches `GET /data/snapshots/2026-03-22` → receives Parquet file
2. DuckDB-WASM opens the Parquet file in the browser
3. Time slider controls a `playbackTimestamp`
4. On each frame: `SELECT * FROM snap WHERE timestamp = (SELECT MAX(timestamp) FROM snap WHERE timestamp <= ?)`
5. Map result rows to `VehiclePosition[]` → construct `WorldState` → feed `applyTick()`
6. Same store → same layers → same rendering. Live and playback are indistinguishable.

**Key constraint:** `applyTick()` and the rendering pipeline must not care whether the data came from a live WebSocket tick or a historical DuckDB query. Same `WorldState` shape, same code path.

---

## Architectural seams (must preserve)

If any of these are violated, the time machine becomes a rewrite instead of an addition.

1. **`PollResult` is a pure serializable data object.** No side effects, no socket references. It can be inserted into a database. ✅ Already true.

2. **`processSnapshot()` output is self-contained.** The `VehiclePosition[]` after processing has everything needed to render (lat, lon, bearing, speed, mode, route). ✅ Already true.

3. **`WorldState` is the single interchange format.** Live broadcast and historical playback produce the same shape. ✅ Already true.

4. **`applyTick()` accepts any `WorldState` regardless of source.** ✅ Already true.

5. **Client rendering has no dependency on WebSocket liveness.** Layers render from store state. ✅ Already true.

6. **The server exposes an HTTP endpoint for snapshot export.** ⚠️ Not yet implemented. Requires a `/data/snapshots/:date` route that runs `COPY TO PARQUET` and streams the result.

### What must NOT change

- `WorldState` type shape — adding fields is fine, removing/renaming is not
- `applyTick()` signature — it must keep accepting a `WorldState`
- `PollResult` must remain serializable (no functions, no circular refs)
- The store must remain the single source of truth for what's on screen

---

## Config additions (future)

```env
# Recording
RECORDING_ENABLED=false
RECORDING_RETENTION_DAYS=30
RECORDING_DATA_DIR=.data/snapshots
```

**Timezone is not configurable.** It is hardcoded to `Australia/Melbourne`. This is a Melbourne transport map — the file dates must match PTV's service day boundaries, which are defined in Melbourne time. A server running in UTC, US-East, or anywhere else still names files by Melbourne date.

---

## Implementation phases

### Phase A: Server-side DuckDB recording
- Add `duckdb` dependency to server
- Add `recorder/` module: init DuckDB, create table, batch insert after each poll
- Add `RECORDING_ENABLED`, `RECORDING_RETENTION_DAYS`, `RECORDING_DATA_DIR` env vars
- Add retention cleanup on startup (delete old `.duckdb` files)
- Non-fatal: if DuckDB init fails, log warning and continue without recording
- No client changes

**Validation:** Enable recording, run server for 5 minutes. `.data/snapshots/YYYY-MM-DD.duckdb` exists. Query it with `duckdb` CLI: `SELECT COUNT(*) FROM snapshots` returns > 0. `SELECT COUNT(DISTINCT timestamp) FROM snapshots` shows ~43 distinct timestamps (5 min ÷ 7s). Disable recording, restart — no `.duckdb` file created.

### Phase B: Parquet export endpoint
- Add `GET /data/snapshots/:date` to server HTTP routes
- Handler runs `COPY TO PARQUET`, streams the file to the client
- Add `GET /data/snapshots` to list available dates
- Cache exported Parquet files (avoid re-exporting the same day repeatedly)

**Validation:** `curl http://localhost:3000/data/snapshots/2026-03-22 -o day.parquet`. Open with `duckdb`: `SELECT COUNT(*) FROM 'day.parquet'` returns rows. `curl http://localhost:3000/data/snapshots` returns a JSON array of available dates.

### Phase C: Client-side DuckDB-WASM playback
- Add `@duckdb/duckdb-wasm` to client dependencies
- Add date picker UI
- Add time slider UI (scrubber bar at bottom of screen)
- Add playback engine: fetch Parquet → init DuckDB-WASM → query by timestamp → map to `WorldState` → `applyTick()`
- Toggle between live mode and playback mode (mutually exclusive — live WS pauses during playback)
- Trail rendering works automatically (store already tracks positions)

**Validation:** Pick a recorded day. Drag the time slider — vehicles jump to their historical positions. Hit play — vehicles animate through the day. Switch back to live mode — WebSocket reconnects, live data resumes.

### Phase D: Day compression / timelapse
- "Play day" button: compress 24h into configurable duration
- Playback speed: 1×, 10×, 60×, 360× (1 second = 1 hour)
- Progress bar showing time-of-day with sunrise/sunset markers
- Vehicle count graph overlay (mini sparkline showing network activity over the day)

**Validation:** Play a full day at 360×. 24h completes in ~4 minutes. The morning rush is visible as a burst of arrows. Late night shows a sparse network. Vehicle count sparkline peaks match rush hours.
