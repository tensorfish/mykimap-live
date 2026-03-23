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

## Poll cycle (every 7 seconds)

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

## Time machine (implemented)

DuckDB on both sides. Server records raw feed data, client plays it back.

**Server:** Before `processSnapshot()`, batch-inserts raw GTFS-RT data into DuckDB (`.data/snapshots/YYYY-MM-DD.duckdb`, Melbourne time). `GET /data/snapshots/:date` exports to Parquet.

**Client:** DuckDB-WASM loads the Parquet file into memory. All snapshots parsed into a sorted array. During playback, `advancePlayback()` feeds snapshots into `applyTick()` as the timestamp crosses them. `clientSnapToShape()` snaps raw GPS positions to cached route shapes. The same `feedTick` → `computeFrame` pipeline handles animation, trails, and bearing — identical to live mode.

**Single animation pipeline:**

```mermaid
flowchart LR
    subgraph SOURCES["Data Sources"]
        LIVE["WebSocket tick"]
        PLAY["Playback snapshot"]
    end
    SOURCES --> AT["applyTick()"]
    AT --> STORE["TanStack Store"]
    STORE --> FT["feedTick()"]
    FT --> SNAP["clientSnapToShape()"]
    SNAP --> CF["computeFrame(dtMs × speed)"]
    CF --> RENDER["deck.gl render"]
```

One render loop. One speed multiplier. Zero duplicate animation code.

## Key timing constants

| Constant | Value |
|---|---|
| Feed poll interval | 7s |
| Broadcast interval | ~1s |
| Stale vehicle threshold | 120s |
| Client stale threshold | 5s |
| Reconnect max retries | 5 |
| Reconnect backoff | exponential (1s base) |
