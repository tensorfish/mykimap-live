# Setup

## Prerequisites

- [Bun](https://bun.sh) (runtime and package manager)
- A [Transport Victoria Open Data](https://opendata.transport.vic.gov.au) API key
- A [Mapbox](https://account.mapbox.com/access-tokens/) access token

## Install

```bash
bun install
```

## Configure

Copy the example env file and fill in your keys:

```bash
cp .env.example .env
```

```env
OPENDATA_VIC_API_KEY=your-api-key-here
MAPBOX_ACCESS_TOKEN=your-mapbox-token-here
```

The client reads its Mapbox token from `VITE_MAPBOX_ACCESS_TOKEN` (Vite exposes env vars prefixed with `VITE_`). Add this to `.env` as well:

```env
VITE_MAPBOX_ACCESS_TOKEN=your-mapbox-token-here
```

## Development

Run the server and client simultaneously:

```bash
# Terminal 1 — server (port 3000)
bun run dev:server

# Terminal 2 — client (port 5173, proxies /ws to server)
bun run dev:client
```

Or run everything:

```bash
bun run dev
```

## Build

```bash
bun run build
```

## Project structure

```
packages/
  server/       → Bun backend: polls GTFS-RT, interpolates, broadcasts via WebSocket
  client/       → Vite frontend: deck.gl + Mapbox map, TanStack Store for state
docs/           → This VitePress documentation site
.memory/        → Design documents and data analysis
```
