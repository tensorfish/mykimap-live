# mykimap

Live map of ~2,000 public transport vehicles across Victoria, Australia. Trams, trains, buses, and V/Line services move in real time on a dark map with route-following animation, congestion heatmaps, and historical playback.

## Quickstart

```bash
git clone https://github.com/tensorfish/mykimap.git
cd mykimap
bun install
cp .env.example .env   # fill in your API keys
bun run build
bun run start           # → http://localhost:3000
```

You need two free API keys in `.env`:

| Variable | Source |
|---|---|
| `OPENDATA_VIC_API_KEY` | [Transport Victoria Open Data](https://opendata.transport.vic.gov.au) — register, check profile |
| `VITE_MAPBOX_ACCESS_TOKEN` | [Mapbox](https://account.mapbox.com/access-tokens/) — free tier works |

First run downloads GTFS Schedule (~191 MB) and caches it in `.cache/gtfs/`.

### Development

```bash
bun run dev:server   # port 3000, hot reload
bun run dev:client   # port 5173, HMR
```

### Reverse proxy (Caddy)

```
mykimap.live {
    reverse_proxy localhost:3000
}
```

Caddy automatically adds `X-Forwarded-For` and `X-Real-Ip` headers. The server reads these to resolve the real client IP for rate limiting and WebSocket connection limits. No extra Caddy config needed — this works out of the box.

## Project structure

| Package | What |
|---|---|
| `packages/server` | Bun backend — polls GTFS-RT feeds, snaps to route shapes, broadcasts via WebSocket, records to DuckDB |
| `packages/client` | Vanilla TS frontend — Mapbox GL + deck.gl, TanStack Store, no framework |
| `packages/tools` | CLI utilities (synthetic test data generator) |
| `docs` | VitePress documentation site (`bun run dev:docs`) |

## License

Data: [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) — Department of Transport and Planning, Victoria.
