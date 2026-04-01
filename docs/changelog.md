# Changelog

## [Unreleased]

### Bug Fixes
- **Fixed incorrect "Avg Speed" display for vehicles** — both live view and replay showed wrong speeds. The client-side speed calculation divided a single interpolation step (~1s of movement) by the full feed update interval (~30s), producing values ~30× too low. Fixed by tracking total distance between feed timestamp changes. In live mode, the server-computed average speed is now preferred for display.

### Architecture
- **Single animation pipeline** — live and playback share the same `feedTick` → `computeFrame` → render chain. No duplicate animation code.
- **Route-based animation** — vehicles animate along cached GTFS route shapes. Position, bearing, and trail all derived from shape geometry.
- **30s delayed playback** — server interpolates between two known poll positions. No prediction, no overshoot.
- **Client-side shape snapping** — playback data (raw GPS) is snapped to route shapes on the client, enabling the same animation as live data.
- **Single render loop** — one `requestAnimationFrame` loop handles live and playback. Speed multiplier controls pace (1×=live, 10-360×=playback, 0=paused).
- **YouTube-style streaming playback** — 30-minute chunks loaded on demand instead of full-day download. Metadata endpoint for instant slider. Buffer bar shows loaded ranges. Inline buffering indicator.

### Features
- **Time machine** — DuckDB records raw feed data. DuckDB-WASM streams Parquet chunks in the browser. Date picker, time slider, speed control (1×/10×/60×/360×).
- **Streaming playback** — click History, pick a date, slider is interactive in <2s (metadata only). Press play, first chunk loads in seconds. Prefetches ahead. No full-day download required.
- **Shareable replay URLs** — `mykimap.live/replay/2026-03-23/08:00` opens directly into playback at that moment. URL updates as playback advances. Copy at any point to share.
- **Buffer bar** — YouTube-style loaded-range indicator on the time slider.
- **Vehicle selection** — click an arrow to see route info, speed, class (trams), alerts. Full route shape highlighted on map.
- **Mode filters** — toggle Trains/Trams/Buses/V/Line with vehicle counts.
- **Animated trails** — 800m trail follows each arrow along the route. "Eats itself" when the arrow stops.
- **Mobile-friendly** — responsive layout, touch-friendly controls, playback slider on its own row.
- **Instant movement on load** — arrows start at oldest backlog position and animate forward.

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
- Streaming playback: chunk manager (`playback-chunks.ts`) fetches 30-min Parquet chunks on demand
- DuckDB-WASM decodes chunks, builds per-vehicle timelines incrementally
- Prefetch next chunk while playing, evict old chunks (LRU, max 4)
- Inline "Buffering..." indicator replaces full-screen loading modal
- Buffer bar on slider shows loaded time ranges
- Single `requestAnimationFrame` loop for live + playback
- Speed multiplier: live=1, playing=speed, paused/buffering=0

### Tools
- `packages/tools/generate-snapshot.ts` — generate synthetic test data matching real API format
- Vehicles traverse real Melbourne route geometry with dwell at terminus
- `bun run generate-snapshot -- --date 2026-03-22 --vehicles 30`
