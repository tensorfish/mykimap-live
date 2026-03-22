# GTFS Realtime — Victoria, Australia

Live vehicle position, trip update, and service alert data for public transport in Victoria, fetched from the Transport Victoria Open Data Portal.

---

## Complete Feed Inventory

**10 feeds** across 4 modes and 3 feed types. Not all combinations exist.

| Mode | Vehicle Positions | Trip Updates | Service Alerts |
|---|---|---|---|
| Metro Train | ✓ | ✓ | ✓ |
| Tram (Yarra Trams) | ✓ | ✓ | ✓ |
| Bus (Metro & Regional) | ✓ | ✓ | ✗ |
| V/Line (Regional Train) | ✓ | ✓ | ✗ |

Bus and V/Line have **no service alerts feed** (404 confirmed).

---

## Authentication

### Header

```
KeyID: <api-key>
```

**Not** `Ocp-Apim-Subscription-Key` — that was the old DEP platform, decommissioned Sep 2025.

### Current key

Stored in `.env` as `OPENDATA_VIC_API_KEY`. Works as of March 2026.

### Getting a new key

Register at https://opendata.transport.vic.gov.au → Login → profile page shows the API key.

---

## Base URL

```
https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1
```

### All endpoints

```
GET {base}/metro/vehicle-positions
GET {base}/metro/trip-updates
GET {base}/metro/service-alerts
GET {base}/tram/vehicle-positions
GET {base}/tram/trip-updates
GET {base}/tram/service-alerts
GET {base}/bus/vehicle-positions
GET {base}/bus/trip-updates
GET {base}/vline/vehicle-positions
GET {base}/vline/trip-updates
```

---

## Rate Limits

From the `x-rate-limit` response header:

- **~20 requests per ~30-second window** per endpoint (first tier).
- **~300–900 requests per ~30-second window** across all endpoints (second tier, account-level — varies by endpoint).
- The server caches data for **~30 seconds** — polling faster returns identical data.

**Safe polling interval: 30 seconds for all feeds in parallel.**

With 10 feeds at 30s each, that's 20 requests per minute — well within limits.

---

## Data Format

All responses are **Protocol Buffer (protobuf)** binary, following the [GTFS Realtime v2.0 spec](https://gtfs.org/documentation/realtime/reference/).

Content-Type: `application/octet-stream`
Content-Disposition: `attachment; filename=GTFSR_<timestamp>.pb`

All feeds use `FULL_DATASET` incrementality — each response is a complete snapshot, not a diff.

---

# Feed Type 1: Vehicle Positions

## Overview

| Mode | Typical entities | Payload size | Has bearing? | Has speed? |
|---|---|---|---|---|
| Metro Train | ~90 | ~13 KB | ✓ (98%) | ✗ |
| Tram | ~160 | ~20 KB | ✗ (0%) | ✗ |
| Bus | ~1,700 | ~186 KB | ✓ (91%) | ✗ |
| V/Line | ~30 | ~3 KB | ✓ (100%) | ✗ |

**Total: ~2,000 vehicles across all feeds.**

## Message Structure

```
FeedMessage
├── header
│   ├── gtfs_realtime_version: "2.0"
│   ├── incrementality: FULL_DATASET (0)
│   └── timestamp: int64 (POSIX seconds)
└── entity[] (repeated)
    ├── id: string (matches trip_id)
    └── vehicle: VehiclePosition
        ├── trip
        │   ├── trip_id: string
        │   ├── route_id: string
        │   ├── start_time: string ("HH:MM:SS")
        │   └── start_date: string ("YYYYMMDD")
        ├── vehicle
        │   ├── id: string
        │   ├── label: string (tram class — tram only)
        │   └── license_plate: string (always empty)
        ├── position
        │   ├── latitude: float (WGS-84)
        │   ├── longitude: float (WGS-84)
        │   ├── bearing: float (degrees from true north — no trams)
        │   └── speed: float (always 0 — never provided)
        ├── stop_id: string (always empty)
        ├── current_status: enum (always IN_TRANSIT_TO)
        └── timestamp: int64 (per-vehicle POSIX timestamp)
```

## Field Availability Per Mode

| Field | Metro Train | Tram | Bus | V/Line |
|---|---|---|---|---|
| `trip.trip_id` | ✓ 100% | ✓ 100% | ✓ 100% | ✓ 100% |
| `trip.route_id` | ✓ 100% | ✓ 100% | ✓ 100% | ✓ 100% |
| `trip.start_time` | ✓ 100% | ✓ 100% | ✓ 100% | ✓ 100% |
| `trip.start_date` | ✓ 100% | ✓ 100% | ✓ 100% | ✓ 100% |
| `trip.direction_id` | ✗ | ✗ | ✗ | ✗ |
| `trip.schedule_relationship` | ✗ | ✗ | ✗ | ✗ |
| `vehicle.id` | ✓ 100% | ✓ 100% | ✓ 100% | ✓ 93% |
| `vehicle.label` | ✗ | ✓ 100% (tram class) | ✗ | ✗ |
| `position.latitude` | ✓ 100% | ✓ 100% | ✓ 100% | ✓ 100% |
| `position.longitude` | ✓ 100% | ✓ 100% | ✓ 100% | ✓ 100% |
| `position.bearing` | ✓ 98% | **✗ 0%** | ✓ 91% | ✓ 100% |
| `position.speed` | ✗ | ✗ | ✗ | ✗ |
| `stop_id` | ✗ | ✗ | ✗ | ✗ |
| `current_status` | all `IN_TRANSIT_TO` | all `IN_TRANSIT_TO` | all `IN_TRANSIT_TO` | all `IN_TRANSIT_TO` |
| `timestamp` | ✓ 100% | ✓ 100% | ✓ 100% | ✓ 100% |
| `congestion_level` | ✗ | ✗ | ✗ | ✗ |
| `occupancy_status` | ✗ | ✗ | ✗ | ✗ |

### What's missing and must be calculated

- **Speed** — no feed provides it. Derive from distance between consecutive positions ÷ time delta.
- **Tram bearing** — 0% presence. Infer from angle between consecutive lat/lon samples.
- **Stopped vs moving** — `current_status` is always `IN_TRANSIT_TO`. Detect stationary vehicles by checking if position hasn't changed between polls.

## Timestamp Freshness

Per-vehicle timestamp age relative to the feed header:

| Mode | Min age | Max age | Avg age |
|---|---|---|---|
| Metro Train | 10s | 875s (~15m) | 117s (~2m) |
| Tram | 67s | 797s (~13m) | 90s (~1.5m) |
| Bus | 20s | 711s (~12m) | 55s (~1m) |
| V/Line | 58s | 364s (~6m) | 92s (~1.5m) |

**Implication:** Within a single snapshot, freshness varies wildly. Vehicles with old timestamps (>120s) are likely parked at termini or depots — do not interpolate them.

## Geographic Coverage

| Mode | Latitude range | Longitude range | Area |
|---|---|---|---|
| Metro Train | -38.17 to -37.58 | 144.66 to 145.33 | Melbourne metro |
| Tram | -37.91 to -37.70 | 144.88 to 145.18 | Inner Melbourne |
| Bus | -38.38 to -36.71 | 143.80 to 146.56 | All Victoria |
| V/Line | -38.36 to -36.13 | 142.64 to 146.50 | All Victoria |

---

# Feed Type 2: Trip Updates

## Overview

| Mode | Typical entities | Payload size | Avg stops/trip |
|---|---|---|---|
| Metro Train | ~143 | ~35 KB | 5.2 |
| Tram | ~361 | ~62 KB | 2.5 |
| Bus | ~651 | ~180 KB | 6.2 |
| V/Line | ~45 | ~7 KB | 2.4 |

## Message Structure

```
FeedMessage
└── entity[]
    ├── id: string ("{trip_id}|{start_date}")
    └── trip_update: TripUpdate
        ├── trip
        │   ├── trip_id: string
        │   ├── route_id: string
        │   ├── start_time: string
        │   ├── start_date: string
        │   └── schedule_relationship: enum
        ├── vehicle.id: string (always empty)
        ├── timestamp: int64 (always 0)
        └── stop_time_update[] (repeated)
            ├── stop_sequence: uint32
            ├── stop_id: string
            ├── arrival
            │   ├── delay: int32 (always 0 — not used)
            │   └── time: int64 (predicted POSIX timestamp)
            ├── departure
            │   ├── delay: int32 (always 0 — not used)
            │   └── time: int64 (predicted POSIX timestamp)
            └── schedule_relationship: enum
```

## Key observations

- **`arrival.delay` / `departure.delay` are always 0** across all modes. Victoria uses **absolute predicted times** (`arrival.time` / `departure.time`) instead of delay offsets.
- **`vehicle.id` is always empty** — trip updates are not linked to specific vehicles within the feed. You must join on `trip_id` to correlate with vehicle positions.
- **`trip.schedule_relationship`** is overwhelmingly `SCHEDULED`. Bus has a small number of `ADDED` trips (7 of 651).
- **Stop-level `schedule_relationship`**: mostly `SCHEDULED` with occasional `ADDED` stops (38 of 747 for metro, 12 of 895 for tram).
- Trip updates contain **remaining stops only** — stops already passed are not included.

## What trip updates are useful for

1. **Next-stop prediction** — show "arriving at X in Y seconds" on vehicle tooltips.
2. **Delay detection** — compare `arrival.time` against the GTFS Schedule to calculate delay.
3. **Trip matching** — confirm which route/trip a vehicle is serving when vehicle position trip_id matches.

---

# Feed Type 3: Service Alerts

Only available for **Metro Train** and **Tram**.

## Overview

| Mode | Typical entities | Payload size |
|---|---|---|
| Metro Train | ~41 | ~51 KB |
| Tram | ~4 | ~1 KB |

## Message Structure

```
FeedMessage
└── entity[]
    ├── id: string (UUID)
    └── alert: Alert
        ├── active_period[] (repeated)
        │   ├── start: int64 (POSIX)
        │   └── end: int64 (POSIX)
        ├── informed_entity[] (repeated)
        │   ├── agency_id: string
        │   ├── route_id: string
        │   ├── stop_id: string
        │   └── trip (TripDescriptor)
        ├── cause: enum
        ├── effect: enum
        ├── url
        │   └── translation[].text: string
        ├── header_text
        │   └── translation[].text: string
        └── description_text
            └── translation[].text: string
```

## Key observations — Metro Train

- **Cause distribution**: `POLICE_ACTIVITY` (21), `TECHNICAL_PROBLEM` (19), `OTHER_CAUSE` (1). Note: "police activity" is Victoria's generic term for planned works.
- **Effect distribution**: `OTHER_EFFECT` (21), `MODIFIED_SERVICE` (10), `REDUCED_SERVICE` (7), `SIGNIFICANT_DELAYS` (3).
- **All 41 alerts** have `url`, `header_text`, `description_text`, and `active_period`.
- **`informed_entity`** includes route_id, agency_id, and stop_id — rich enough to highlight affected routes and stops on the map.
- Sample: *"Planned work: Buses replace trains between Parliament and Hurstbridge"* with 96 informed entities listing every affected stop.

## Key observations — Tram

- **Only 4 alerts** at time of sampling.
- **No `active_period`** on tram alerts (unlike metro train).
- **Cause**: always `OTHER_CAUSE`. **Effect**: always `UNKNOWN_EFFECT`.
- Alerts are plain text: *"Until last tram 30 Nov, buses replace Route 57 trams..."*
- **`informed_entity`** contains `route_id` only (no stop_id).

## What service alerts are useful for

1. **Map overlays** — highlight affected routes/stops with a disruption indicator.
2. **Info panel** — show active disruption descriptions when a user taps an affected vehicle or route.
3. **Filtering** — let users see which routes are disrupted.

---

# GTFS Schedule (Static Data)

The companion dataset needed to resolve route names, stop names, route colors, and route shapes.

**Download URL**: `https://opendata.transport.vic.gov.au/dataset/.../download/gtfs.zip`
**Size**: ~191 MB (ZIP), ~214 MB uncompressed.

## Structure

The ZIP contains **8 sub-ZIPs**, one per mode:

| Folder | Mode | Routes | Stops | Trips | Shapes |
|---|---|---|---|---|---|
| `1/` | V/Line (Regional Train) | 13 | 511 | 5,630 | 1,154 |
| `2/` | Metro Train | 36 | 2,408 | 43,455 | 1,734 |
| `3/` | Tram | 24 | 1,639 | 77,834 | 940 |
| `4/` | Metro Bus | 724 | 22,472 | 230,486 | 2,632 |
| `5/` | V/Line Coach | 52 | 852 | 3,965 | — |
| `6/` | Regional Bus | 207 | 3,283 | 4,927 | — |
| `10/` | Interstate Rail (The Overland) | 1 | 20 | 17 | — |
| `11/` | SkyBus (Airport) | 5 | 34 | 2,495 | — |

Each sub-ZIP is a standard GTFS package: `routes.txt`, `stops.txt`, `trips.txt`, `stop_times.txt`, `shapes.txt`, `calendar.txt`, `calendar_dates.txt`, `agency.txt`, `transfers.txt`, `pathways.txt`, `levels.txt`.

## Files relevant to this project

### routes.txt — Route names and colors

```csv
route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color
"aus:vic:vic-02-FKN:","","Frankston","Frankston - City","400","028430","FFFFFF"
```

### stops.txt — Stop names and coordinates

```csv
stop_id,stop_name,stop_lat,stop_lon,stop_url,location_type,parent_station,wheelchair_boarding,level_id,platform_code
"10117","Jordanville Station","-37.87360157","145.11197651","...","","vic:rail:JOR","1","Level 1","1"
```

### shapes.txt — Route geometry for drawing lines on the map

```csv
shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled
"2-ALM-vpt-1.1.R","-37.86818462","145.07969648","1","0.00"
```

**3.7 million shape points** across all modes — enough to draw detailed route lines.

## Route Colors (from GTFS Schedule)

### Metro Train Lines

| route_id | Line | Color |
|---|---|---|
| `aus:vic:vic-02-ALM:` | Alamein | `#152C6B` |
| `aus:vic:vic-02-BEG:` | Belgrave | `#152C6B` |
| `aus:vic:vic-02-CBE:` | Cranbourne | `#34ACE1` |
| `aus:vic:vic-02-CCL:` | City Circle | `#0072CE` |
| `aus:vic:vic-02-CGB:` | Craigieburn | `#FFBE00` |
| `aus:vic:vic-02-FKN:` | Frankston | `#028430` |
| `aus:vic:vic-02-GWY:` | Glen Waverley | `#152C6B` |
| `aus:vic:vic-02-HBE:` | Hurstbridge | `#BE1014` |
| `aus:vic:vic-02-LIL:` | Lilydale | `#152C6B` |
| `aus:vic:vic-02-MDD:` | Mernda | `#BE1014` |
| `aus:vic:vic-02-PKM:` | Pakenham | `#34ACE1` |
| `aus:vic:vic-02-RCE:` | Flemington Racecourse | `#95979A` |
| `aus:vic:vic-02-SHM:` | Sandringham | `#F178AF` |
| `aus:vic:vic-02-STY:` | Stony Point | `#028430` |
| `aus:vic:vic-02-SUY:` | Sunbury | `#34ACE1` |
| `aus:vic:vic-02-UFD:` | Upfield | `#FFBE00` |
| `aus:vic:vic-02-WER:` | Werribee | `#F178AF` |
| `aus:vic:vic-02-WIL:` | Williamstown | `#F178AF` |

### Tram Routes

| Route | Color |
|---|---|
| 1 | `#B5BD00` |
| 3 | `#8DC8E8` |
| 5 | `#D50032` |
| 6 | `#01426A` |
| 11 | `#6ECEB2` |
| 12 | `#007E92` |
| 16 | `#FBD872` |
| 19 | `#8A1B61` |
| 30 | `#534F96` |
| 35 | `#6B3529` (City Circle) |
| 48 | `#333434` |
| 57 | `#00C1D5` |
| 58 | `#969696` |
| 59 | `#00653A` |
| 64 | `#00AB8E` |
| 67 | `#956C58` |
| 70 | `#F59BBB` |
| 72 | `#9ABEAA` |
| 75 | `#00A9E0` |
| 78 | `#A0A0D6` |
| 82 | `#D2D755` |
| 86 | `#FFB500` |
| 96 | `#C6007E` |
| 109 | `#E87722` |

### Tram Vehicle Classes (from vehicle.label)

| Label | Class | Count (typical) |
|---|---|---|
| B2 | B2-class | ~61 |
| E | E-class | ~25 |
| C1 | C1-class | ~20 |
| Z3 | Z3-class | ~18 |
| A2 | A2-class | ~16 |
| A1 | A1-class | ~13 |
| D1 | D1-class | ~6 |
| D2 | D2-class | ~5 |
| W | W-class | ~1 |

### Bus

- `route_color`: `#FF8200` for all regional bus. Metro bus varies.
- `route_id` format differs: metro bus uses plain numbers (`406`), regional bus uses `6-14-mjp-1` style.

### V/Line

- `route_color`: `#A57FB2` for all V/Line services.

---

## Entity ID and Vehicle ID Patterns

### Metro Train

- **entity.id / trip_id**: `02-WIL--38-T3-6324`
- **route_id**: `aus:vic:vic-02-WIL:` — line code after last `-` before `:`
- **vehicle.id**: `1147T-1187T-593M-594M-641M-674M` — carriage consist, dash-separated

### Tram

- **entity.id / trip_id**: `03-1--16-T3-140671148` — route number after `03-`
- **route_id**: `aus:vic:vic-03-1:` — route number after last `-`
- **vehicle.id**: `2042` — numeric fleet number
- **vehicle.label**: tram class (`B2`, `E`, `C1`, etc.)

### Bus

- **entity.id / trip_id**: `60-406--1-Sun4-3584370` — route number is second segment
- **route_id**: `406` — plain number (not namespaced)
- **vehicle.id**: `BS05FK` — registration-style identifier

### V/Line

- **entity.id / trip_id**: `01-ABY--5-T3-8620` — line code is second segment
- **route_id**: `aus:vic:vic-01-ABY:` — namespaced with line code
- **vehicle.id**: `V1197` — fleet number prefixed with `V`

---

## Feed Update Cadence

- Server-side cache refreshes every **~30 seconds** (confirmed: consecutive fetches 35s apart showed header timestamps differing by 32s).
- Entity counts change between polls as vehicles enter/leave service.
- Fetching faster than 30s returns identical data.

---

## Polling Strategy for the Server

```
Every 30 seconds, in parallel:
  ┌─ Fetch metro/vehicle-positions     (~13 KB)
  ├─ Fetch tram/vehicle-positions      (~20 KB)
  ├─ Fetch bus/vehicle-positions       (~186 KB)
  ├─ Fetch vline/vehicle-positions     (~3 KB)
  ├─ Fetch metro/trip-updates          (~35 KB)
  ├─ Fetch tram/trip-updates           (~62 KB)
  ├─ Fetch bus/trip-updates            (~180 KB)
  ├─ Fetch vline/trip-updates          (~7 KB)
  ├─ Fetch metro/service-alerts        (~51 KB)
  └─ Fetch tram/service-alerts         (~1 KB)

Total per poll: ~558 KB across 10 parallel requests
Per minute: ~1.1 MB
Per hour: ~67 MB
```

### After each poll

1. Decode all 10 protobuf responses.
2. Diff vehicle positions against previous snapshot — detect new/removed vehicles, recalculate speed and bearing.
3. Merge trip updates — match by `trip_id` to enrich vehicle data with next-stop predictions.
4. Merge service alerts — associate with `route_id` to flag affected routes.
5. Between polls, interpolate vehicle positions using calculated speed + bearing.
6. Broadcast interpolated state to all clients every ~1s.

### Stale vehicle handling

Vehicles with per-entity timestamps >120s old are likely parked. Do not interpolate — hold them at their last known position.
