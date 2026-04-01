# Future: Time Machine (Route Playback)

Status: **Implemented.** YouTube-style streaming playback with chunked loading. Metadata loads instantly, 30-minute chunks stream on demand, buffer bar shows loaded ranges.

---

## What it is

A time slider on the map that lets you scrub through historical vehicle positions. Drag left to watch the morning rush build. Hit play to watch an entire day compress into 60 seconds — 2,000 arrows streaming through the city, trails painting the network's pulse.

## Why it matters

The live map is interesting for 30 seconds. A time-lapse of an entire city's transport network is something people come back to, share, and stare at. It also makes the tool useful beyond enthusiasm — transport planners see bottlenecks, journalists replay incidents, researchers study patterns.

## Data budget

| Metric | Value |
|---|---|
| Snapshot size | ~2,000 vehicles × ~100 bytes ≈ 200 KB |
| Snapshots per day | ~5,760 (one per 15s poll) |
| Rows per day | ~24.6M (2,000 vehicles × 12,300 snapshots) |
| Raw daily volume | ~2.4 GB |
| DuckDB compressed | Estimated < 200 MB/day (columnar compression, every poll should contain fresh data at 15s interval) |

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

- **Write strategy:** Batch insert only when the poll contains fresh data (header timestamp changed from previous poll). Duplicate polls (same header timestamp due to ~30s feed cache) are skipped — no redundant rows. The dedup check already exists in `pollCycle()` via `lastHeaderTimestamp`. Each fresh insert is ~2,000 rows. DuckDB handles this in < 10ms.
- **Non-blocking:** The insert is fire-and-forget with error logging. Poll/broadcast must not wait on slow disk.
- **Optional:** Controlled by `RECORDING_ENABLED` env var (default: `false`). When disabled, no DuckDB instance is created, zero overhead.
- **Retention:** Configurable via `RECORDING_RETENTION_DAYS` env var (default: `30`). On startup, delete `.duckdb` files older than the threshold.
- **Export endpoints:**
  - `GET /data/snapshots/:date` — full-day Parquet export (still works, used for bulk download)
  - `GET /data/snapshots/:date?from={ts}&to={ts}` — range-filtered Parquet chunk (~4–13 MB per 30 min). Cached on disk.
  - `GET /data/snapshots/:date/meta` — metadata (time bounds, snapshot count, available hours). ~1 KB, instant.

### Client: DuckDB-WASM streaming playback

The client streams 30-minute Parquet chunks on demand using [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) — like YouTube buffering video ahead of the playhead. No full-day download required.

**Why DuckDB on both sides:**
- Server uses DuckDB for append-heavy time-series writes (columnar, compressed, fast batch inserts)
- Client uses DuckDB-WASM to decode Parquet chunks in the browser
- Export is a single `COPY TO PARQUET` — no custom serialization
- Range chunks are cached on the server — repeat requests are instant

**Playback flow (YouTube-style):**
1. User picks a date → client fetches `GET /data/snapshots/2026-03-22/meta` (~1 KB) → slider renders instantly
2. User presses play → client fetches first 30-minute chunk (`?from=&to=`) → ~4–13 MB
3. Chunk manager (`playback-chunks.ts`) registers chunk in DuckDB-WASM, decodes to snapshots + timelines
4. Vehicles appear and start moving within seconds
5. While playing, prefetch next chunk in background
6. If playback outruns buffer → inline "Buffering..." on playback bar (not full-screen modal)
7. Buffer bar on slider shows loaded ranges (like YouTube's gray bar)
8. Old chunks evicted (LRU, max 4 loaded) to bound memory at ~20–50 MB

**Key constraint:** `applyTick()` and the rendering pipeline must not care whether the data came from a live WebSocket tick or a historical DuckDB query. Same `WorldState` shape, same code path. `WorldState` now includes `tickTimeMs` so both live and playback can derive constant-velocity motion segments from an authoritative clock.

---

## Architectural seams (must preserve)

If any of these are violated, the time machine becomes a rewrite instead of an addition.

1. **`PollResult` is a pure serializable data object.** No side effects, no socket references. It can be inserted into a database. ✅ Already true.

2. **`processSnapshot()` output is self-contained.** The `VehiclePosition[]` after processing has everything needed to render (lat, lon, bearing, speed, mode, route). ✅ Already true.

3. **`WorldState` is the single interchange format.** Live broadcast and historical playback produce the same shape, including `tickTimeMs` for segment timing. ✅ Already true.

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

### Phase A: Server-side DuckDB recording ✅
- `recorder/` module: init DuckDB, create table, batch insert after each poll
- `RECORDING_ENABLED`, `RECORDING_RETENTION_DAYS`, `RECORDING_DATA_DIR` env vars
- Retention cleanup on startup. Non-fatal if DuckDB init fails.
- Auto-export today's Parquet every 5 minutes.

### Phase B: Parquet export endpoints ✅
- `GET /data/snapshots` — list available dates
- `GET /data/snapshots/:date` — full-day Parquet export
- `GET /data/snapshots/:date?from={ts}&to={ts}` — range-filtered chunk export (cached on disk)
- `GET /data/snapshots/:date/meta` — metadata (time bounds, snapshot count, hours with data)

### Phase C: YouTube-style streaming playback ✅
- Metadata-first: slider renders instantly from ~1 KB metadata response
- 30-minute chunks loaded on demand via DuckDB-WASM (~4–13 MB each)
- Chunk manager (`playback-chunks.ts`): fetch, register, decode, evict (LRU, max 4)
- Prefetch next chunk while playing
- Inline "Buffering..." indicator (not full-screen modal)
- Buffer bar on slider showing loaded ranges (YouTube-style gray bar)
- Seek to unloaded time → brief inline buffer → resume

### Phase D: Day compression / timelapse ✅
- Playback speed: 1×, 10×, 60×, 360× (1 second = 6 minutes at 360×)
- Default speed: 10×

### Future
- Vehicle count sparkline overlay showing network activity over the day
- Sunrise/sunset markers on the timeline
