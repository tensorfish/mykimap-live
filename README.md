# mykimap

A real-time map of every tram, train, and bus in Victoria, Australia.

Open it in a browser and watch ~2,000 vehicles move across the city — trams gliding down their routes, trains running between stations, buses fanning out across the suburbs. Open it in two windows and they're perfectly in sync.

## How it works

A server polls 10 live feeds from Transport Victoria every 15 seconds, decodes the protobuf data, snaps each vehicle onto its actual route geometry, and broadcasts interpolated positions to every connected browser over WebSocket.

The browser renders it all on a dark Mapbox base map using deck.gl for GPU-accelerated animation of thousands of moving arrows with snail trails.

## Quickstart

### Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- A [Transport Victoria Open Data](https://opendata.transport.vic.gov.au) API key (free — register and check your profile)
- A [Mapbox](https://account.mapbox.com/access-tokens/) access token (free tier works)

### Install

```bash
git clone https://github.com/tensorfish/mykimap.git
cd mykimap
bun install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```env
OPENDATA_VIC_API_KEY=your-transport-vic-key
VITE_MAPBOX_ACCESS_TOKEN=your-mapbox-token
```

### Run

```bash
# Start the server (port 3000)
bun run dev:server

# In another terminal — start the client (port 5173)
bun run dev:client
```

Open http://localhost:5173

On first run the server downloads the GTFS Schedule (~191 MB) to build the route shape index. This is cached in `.cache/gtfs/` and only happens once.

### Build

```bash
bun run build
```

## Tools

### Generate test historical data

Generate a synthetic DuckDB snapshot for testing the History playback feature:

```bash
bun run generate-snapshot -- --date 2026-03-22 --vehicles 30
```

This creates `.data/snapshots/2026-03-22.duckdb` with 91 simulated vehicles traveling along real Melbourne route geometry for 24 hours. Click History in the UI to play it back.

Options:

| Flag | Default | Description |
|---|---|---|
| `--date` | `2026-03-22` | Date for the snapshot file |
| `--output` | `.data/snapshots` | Output directory |
| `--gtfs-cache` | `.cache/gtfs` | GTFS data directory |
| `--vehicles` | `30` | Vehicles per mode |
| `--interval` | `30` | Seconds between snapshots |

Requires the GTFS Schedule to be cached first (run the server once to download it).

### History playback

The server records live data to DuckDB by default (`RECORDING_ENABLED=true`). Click **History** in the UI to browse and replay recorded days with adjustable speed (1×, 10×, 60×, 360×). The server auto-exports today's recording to Parquet every 5 minutes.

Recordings are stored in `.data/snapshots/YYYY-MM-DD.duckdb` (Melbourne time) and retained for 30 days.

### Congestion heatmap

Toggle "Congestion" in the expanded filter bar to overlay speed-colored route segments. Green = flowing, yellow = slow, red = stopped. Based on 10 minutes of accumulated vehicle speed data.

### Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play/pause (playback mode) |
| Escape | Deselect vehicle / close panel |
| ← → | Skip ±15s (playback mode) |

## Docs

```bash
bun run dev:docs
```

Opens the VitePress documentation site with architecture diagrams, data flow, and setup guide.

## Project structure

```
packages/
  server/             Bun backend
    src/
      index.ts          Boot, poll loop, broadcast loop, HTTP + WebSocket
      config.ts         Environment, feed URLs, timing constants
      types.ts          Shared type definitions
      state-machine.ts  Server state machine with transition logging
      logger.ts         Structured logging
      poller/           GTFS-RT feed fetching and protobuf decoding
      interpolation/    Shape-following interpolation, 30s delayed playback
      shapes/           GTFS Schedule loader, route shape index, polyline snapping
      recorder/         DuckDB recording + auto Parquet export (every 5 min)
      congestion/       Per-segment speed tracking for heatmap
      broadcast/        WebSocket client management
    proto/
      gtfs-realtime.proto
  client/             Vite frontend (no framework)
    src/
      main.ts           Bootstrap
      store.ts          TanStack Store — reactive app state
      state-machine.ts  Client state machine
      ws.ts             WebSocket with auto-reconnect
      map.ts            Mapbox GL JS + deck.gl initialization
      layers.ts         Vehicle arrows, trails, heatmap, shape cache, animation
      panel.ts          Vehicle info panel
      filters.ts        Mode chips, route/vehicle filter, congestion toggle
      styles.css        All CSS
      playback.ts       DuckDB-WASM historical playback engine
      playback-ui.ts    Playback controls (date picker, slider, speed)
      icons.ts          Arrow icon generation
      ui.ts             Status bar
  tools/              CLI utilities
    src/
      generate-snapshot.ts  Generate synthetic test data
docs/                 VitePress documentation site
.memory/              Design documents and data analysis
.data/snapshots/      DuckDB recordings (gitignored)
.cache/gtfs/          Cached GTFS Schedule (gitignored)
```

## What's in the feeds

| Mode | Vehicles | Bearing? | Speed? |
|---|---|---|---|
| Metro Train | ~90 | ✓ | ✗ |
| Tram | ~160 | ✗ | ✗ |
| Bus | ~1,700 | ✓ | ✗ |
| V/Line | ~30 | ✓ | ✗ |

No feed provides speed. Trams provide no bearing. Both are calculated by the server from consecutive position snapshots and route shape geometry.

## License

Data: [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) — Department of Transport and Planning, Victoria.
