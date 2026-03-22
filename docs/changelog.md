# Changelog

## [Unreleased]

### Added
- Project scaffolding: Bun monorepo with `packages/server`, `packages/client`, and `docs/`
- Server: GTFS-RT feed polling (10 feeds), protobuf decoding, position interpolation, WebSocket broadcast
- Server: State machine with transition logging (BOOT → RUNNING → DEGRADED → STALE)
- Client: Mapbox GL JS dark base map with deck.gl ScatterplotLayer overlay
- Client: TanStack Store for reactive state management (no React)
- Client: WebSocket connection with auto-reconnect and exponential backoff
- Client: Status bar showing connection state, vehicle count, and alert count
- Docs: VitePress site with architecture, data flow, setup guide, and changelog
- GTFS-RT data analysis: live feed structure, field availability, rate limits, and polling strategy documented in `.memory/`
