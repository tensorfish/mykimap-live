# Data Flow

## Feed inventory

10 GTFS Realtime feeds from Transport Victoria:

| Mode | Vehicle Positions | Trip Updates | Service Alerts |
|---|---|---|---|
| Metro Train | ✓ ~90 vehicles | ✓ ~143 trips | ✓ ~41 alerts |
| Tram | ✓ ~160 vehicles | ✓ ~361 trips | ✓ ~4 alerts |
| Bus | ✓ ~1,700 vehicles | ✓ ~651 trips | ✗ |
| V/Line | ✓ ~30 vehicles | ✓ ~45 trips | ✗ |

All feeds use Protocol Buffer encoding and the `KeyID` header for authentication.

## Poll cycle (every 15 seconds)

```mermaid
flowchart LR
    FETCH["Fetch 10 feeds\nin parallel\n~558 KB"] --> DECODE["Decode\nprotobuf"]
    DECODE --> VP_PROC["Process vehicle\npositions"]
    DECODE --> TU_PROC["Process trip\nupdates"]
    DECODE --> SA_PROC["Process service\nalerts"]

    subgraph VP_PROC_DETAIL["Vehicle position processing"]
        direction TB
        SNAP["Snap to GTFS\nroute shape\n(trip_id → shape_id)"] --> SPEED["Calculate speed\nalong shape polyline"]
        SPEED --> BEARING["Derive bearing\nfrom shape direction"]
        BEARING --> STALE{"Timestamp\n> 120s old?"}
        STALE -- Yes --> MARK_STALE["Mark stale"]
        STALE -- No --> MARK_ACTIVE["Mark active\n(on-shape)"]
    end

    VP_PROC --> VP_PROC_DETAIL

    VP_PROC_DETAIL --> MERGE["Merge by\ntrip_id &\nroute_id"]
    TU_PROC --> MERGE
    SA_PROC --> MERGE
    MERGE --> WORLD["Store as current\nworld state"]
```

## Broadcast cycle (every ~1 second)

```mermaid
flowchart LR
    STATE["Current\nworld state"] --> CHECK{"Vehicle\nstale?"}
    CHECK -- Yes --> HOLD["Hold at last\nknown position"]
    CHECK -- No --> PROGRESS{"t = elapsed /\ntravel time"}
    PROGRESS -- "t ≤ 1" --> LERP["Lerp origin → target\nalong shape"]
    PROGRESS -- "t > 1" --> OVERSHOOT["Project past target\nspeed × overshoot\nalong shape"]
    LERP --> FALLBACK
    OVERSHOOT --> FALLBACK
    HOLD --> JSON["Serialize\nto JSON"]
    FALLBACK{"Has shape?"} -- No --> STRAIGHT["Straight-line\nlerp/projection"]
    FALLBACK -- Yes --> JSON
    STRAIGHT --> JSON
    JSON --> SEND["Send to all\nWebSocket clients"]
```

## Server state machine

```mermaid
stateDiagram-v2
    [*] --> BOOT
    BOOT --> INITIALIZING
    INITIALIZING --> AWAITING_FIRST_POLL
    INITIALIZING --> FATAL
    AWAITING_FIRST_POLL --> RUNNING
    AWAITING_FIRST_POLL --> FATAL
    RUNNING --> DEGRADED
    RUNNING --> SHUTTING_DOWN
    DEGRADED --> RUNNING
    DEGRADED --> STALE
    DEGRADED --> SHUTTING_DOWN
    STALE --> RUNNING
    STALE --> SHUTTING_DOWN
    SHUTTING_DOWN --> STOPPED
```

## Client state machine

```mermaid
stateDiagram-v2
    [*] --> LOADING
    LOADING --> CONNECTING
    LOADING --> ERROR
    CONNECTING --> WAITING_FOR_DATA
    CONNECTING --> RECONNECTING
    WAITING_FOR_DATA --> ACTIVE
    WAITING_FOR_DATA --> RECONNECTING
    ACTIVE --> STALE
    ACTIVE --> RECONNECTING
    STALE --> ACTIVE
    STALE --> RECONNECTING
    RECONNECTING --> CONNECTING
    RECONNECTING --> DISCONNECTED
    DISCONNECTED --> CONNECTING
```

## Time machine — YouTube-style streaming playback

DuckDB on both sides. Server records raw feed data, client streams 30-minute chunks on demand.

### Server endpoints

| Endpoint | Purpose | Response |
|---|---|---|
| `GET /data/snapshots` | List available dates | JSON array of date strings |
| `GET /data/snapshots/:date/meta` | Day metadata (instant) | `{ minTimestamp, maxTimestamp, snapshotCount, hours }` |
| `GET /data/snapshots/:date?from=&to=` | 30-min Parquet chunk | ~4–13 MB binary (cached on disk) |
| `GET /data/snapshots/:date` | Full day Parquet (legacy) | ~150–200 MB binary |

**Recording:** Before `processSnapshot()`, batch-inserts raw GTFS-RT data into DuckDB (`.data/snapshots/YYYY-MM-DD.duckdb`, Melbourne time).

### Client streaming flow

```mermaid
flowchart TD
    DATE["User picks date"] --> META["Fetch metadata\n~1 KB"]
    META --> SLIDER["Slider interactive\nimmediately"]
    SLIDER --> PLAY["User presses play"]
    PLAY --> CHUNK1["Load first\n30-min chunk\n~4-13 MB"]
    CHUNK1 --> RENDER["Vehicles appear\nand start moving"]
    RENDER --> PREFETCH["Prefetch next\nchunk in background"]
    PREFETCH --> SEAMLESS["Seamless\nchunk transition"]
    SEAMLESS --> EVICT["Evict old chunks\n(LRU, max 4)"]
```

The chunk manager (`playback-chunks.ts`) tracks loaded ranges, handles fetch + DuckDB-WASM decode, and evicts old chunks. A buffer bar on the slider shows loaded ranges. Seeking to unloaded time shows a brief inline "Buffering..." indicator, not a full-screen modal.

### Single animation pipeline

```mermaid
flowchart LR
    subgraph SOURCES["Data Sources"]
        LIVE["WebSocket tick"]
        PLAY["Playback chunk\nsnapshot"]
    end
    SOURCES --> AT["applyTick()"]
    AT --> STORE["TanStack Store"]
    STORE --> FT["feedWorldState()"]
    FT --> SNAP["clientSnapToShape()"]
    SNAP --> CF["computeFrame(dtMs × speed)"]
    CF --> RENDER["deck.gl render"]
```

One render loop. One speed multiplier. Zero duplicate animation code.

Live animation rule: each authoritative `WorldState` appends at most one constant-velocity motion segment per vehicle. Segment duration comes from `WorldState.tickTimeMs` on the shared world clock, not the semantic `VehiclePosition.speed` field. Backlog bootstrap replays the same segment model, so startup and steady-state live mode use the same motion contract.

## Key timing constants

| Constant | Value |
|---|---|
| Feed poll interval | 15s |
| Broadcast interval | ~1s |
| Stale vehicle threshold | 120s |
| Client stale threshold | 5s |
| Reconnect max retries | 5 |
| Reconnect backoff | exponential (1s base) |
