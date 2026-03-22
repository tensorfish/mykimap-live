# Changelog

## [Unreleased]

### Changed
- Poll interval: 30s → 7s (catches feed changes faster; most polls return identical data due to ~30s server-side cache)
- Interpolation: vehicles now traverse from origin → target along their GTFS route shape polyline between polls. No teleporting, no building-cutting. Falls back to straight-line for unmatched vehicles.
- Vehicles render as **directional arrows** (IconLayer) rotated to match bearing, not dots
- Added **snail trails** (PathLayer) behind each moving vehicle showing last 40 positions
- Mode colors: blue (metro), green (tram), orange (bus), purple (V/Line)
- Simplified state-transitions documentation (242 → 109 lines)

### Added
- Project scaffolding: Bun monorepo with `packages/server`, `packages/client`, `docs/`
- Server: GTFS-RT feed polling (10 feeds), protobuf decoding, WebSocket broadcast
- Server: GTFS Schedule shape loader — downloads 191 MB ZIP on first boot, caches in `.cache/gtfs/`, builds `trip_id → shape polyline` index
- Server: Route-snapped interpolation — vehicles follow actual road/track/tram geometry
- Server: State machine with transition logging
- Client: Mapbox GL JS dark base map with deck.gl overlay (no framework, vanilla TS)
- Client: TanStack Store for reactive state
- Client: WebSocket with auto-reconnect and exponential backoff
- Client: Status bar showing connection state, vehicle count, alert count
- Docs: VitePress site with Mermaid diagrams
- `.memory/`: GTFS-RT feed analysis, implementation plan
- `AGENTS.md`: AI agent instructions
