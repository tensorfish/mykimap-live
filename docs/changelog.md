# Changelog

## [Unreleased]

### Architecture
- **Single animation pipeline** — live and playback share the same `feedTick` → `computeFrame` → render chain. No duplicate animation code.
- **Route-based animation** — vehicles animate along cached GTFS route shapes. Position, bearing, and trail all derived from shape geometry.
- **30s delayed playback** — server interpolates between two known poll positions. No prediction, no overshoot.
- **Client-side shape snapping** — playback data (raw GPS) is snapped to route shapes on the client, enabling the same animation as live data.
- **Single render loop** — one `requestAnimationFrame` loop handles live and playback. Speed multiplier controls pace (1×=live, 10-360×=playback, 0=paused).

### Features
- **Time machine** — DuckDB records raw feed data. DuckDB-WASM loads Parquet in the browser. Date picker, time slider, speed control (1×/10×/60×/360×).
- **Vehicle selection** — click an arrow to see route info, speed, class (trams), alerts. Full route shape highlighted on map.
- **Mode filters** — toggle Trains/Trams/Buses/V/Line with vehicle counts.
- **Animated trails** — 800m trail follows each arrow along the route. "Eats itself" when the arrow stops.
- **Mobile-friendly** — responsive layout, touch-friendly controls.
- **Instant movement on load** — arrows start at oldest backlog position and animate forward.
- **History button** — inline with Live status, loads DuckDB playback with download progress.

### Server
- Poll interval: 15s (against ~30s feed cache)
- 30s delayed playback interpolation between known snapshots
- DuckDB recording enabled by default (`.data/snapshots/YYYY-MM-DD.duckdb`, Melbourne time)
- Raw feed data recorded before processing (faithful copy of API)
- Dual-direction shape storage per route (dir0 + dir1)
- Parquet export endpoint with WAL-aware active DB connection
- Route shape endpoint with cumulative distances

### Client
- Route-based animation: arrows move along cached GTFS shapes
- Client-side shape snapping for playback data
- Bearing from shape geometry (sample behind + current position)
- Trail = 800m slice of route shape behind the arrow
- DuckDB-WASM loads full day into memory for smooth playback
- Single `requestAnimationFrame` loop for live + playback
- Speed multiplier: live=1, playing=speed, paused=0

### Tools
- `packages/tools/generate-snapshot.ts` — generate synthetic test data matching real API format
- Vehicles traverse real Melbourne route geometry with dwell at terminus
- `bun run generate-snapshot -- --date 2026-03-22 --vehicles 30`
