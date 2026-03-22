# Setup

## Prerequisites

- [Bun](https://bun.sh) (runtime and package manager)
- A [Transport Victoria Open Data](https://opendata.transport.vic.gov.au) API key (free — register and check your profile)
- A [Mapbox](https://account.mapbox.com/access-tokens/) access token (free tier works)

## Install

```bash
bun install
```

## Configure

```bash
cp .env.example .env
```

Fill in both keys:

```env
OPENDATA_VIC_API_KEY=your-transport-vic-key
VITE_MAPBOX_ACCESS_TOKEN=your-mapbox-token
```

## Run

```bash
# Terminal 1 — server (port 3000)
bun run dev:server

# Terminal 2 — client (port 5173, proxies /ws to server)
bun run dev:client
```

On first run the server downloads the GTFS Schedule (~191 MB) to build the route shape index. This is cached in `.cache/gtfs/` and only happens once. If the download fails, the server continues without shapes (straight-line interpolation fallback).

## Build

```bash
bun run build
```

## Project structure

```
packages/
  server/       → Bun backend
    src/
      poller/         Feed fetching + protobuf decoding
      shapes/         GTFS Schedule loader, shape index, polyline snapping
      interpolation/  Origin→target traversal along shapes, geo math
      broadcast/      WebSocket client management
    proto/            gtfs-realtime.proto schema
  client/       → Vite frontend (vanilla TS, no framework)
    src/              Store, WebSocket, map, layers (arrows + trails), icons, UI
docs/           → This VitePress documentation site
.memory/        → Design documents and data analysis
.cache/gtfs/    → Cached GTFS Schedule ZIP + extracted files (gitignored)
```
