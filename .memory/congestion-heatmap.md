# Congestion Heatmap

Speed-colored route segments showing where traffic is flowing or stuck.

## Architecture

**Server-seeds, client-accumulates** pattern:

1. **Server** (`packages/server/src/congestion/index.ts`): On every fresh poll, records per-vehicle speed into 200m route segments. Maintains a 10-minute sliding window. Sends the full snapshot to new WebSocket clients in the `init` message.

2. **Client** (`packages/client/src/layers.ts`): Seeds from the server snapshot on connect. After that, accumulates locally from `feedWorldState()` whenever a vehicle's feed timestamp changes and it has moved. Fills all segments between previous and current position.

3. **Playback**: `buildHeatmapForTime()` in `playback.ts` replays the 10-minute window of snapshots through `recordHeatmapOnly()` — a dedicated function that tracks positions without touching animation state.

## Data Flow

```
Server poll → recordCongestion() → per-segment speed ring buffer
                                  ↓ (on WS connect)
                          getCongestion() → init message → client seedHeatmap()
                                                          ↓
Client feedWorldState() → recordSegmentSpeed() → heatmapData (local ring buffer)
                                        ↓ (every frame, if dirty)
                                createHeatmapLayer() → deck.gl PathLayer
```

## Segment Structure

- **Segment length**: 200m (constant `SEGMENT_LEN`, must match server and client)
- **Storage**: `Map<routeId, RouteHeatmap>` where each has `Map<segIdx, SpeedSample[]>`
- **SpeedSample**: `{ ts: number, speed: number }` — vehicle timestamp + speed in m/s
- **Ring buffer cap**: 60 samples per segment
- **Sliding window**: 600 seconds (10 minutes)
- **Min samples**: 2 (segments with only 1 reading are hidden)

## Color Mapping

Speed is normalized against mode baselines:
- Tram: 8.3 m/s (30 km/h)
- Metro: 22 m/s (80 km/h)
- Bus: 11 m/s (40 km/h)
- V/Line: 28 m/s (100 km/h)

`ratio = speed / baseline`, clamped to [0, 1].
- ratio 0 → red (stopped)
- ratio 0.5 → yellow (slow)
- ratio 1 → green (normal speed)

Alpha scales with sample count (more confidence = more opaque).

## Caching

`createHeatmapLayer()` is called every frame but only rebuilds the PathLayer when `heatmapDirty` is true (set when `recordSegmentSpeed` or `seedHeatmap` runs). Otherwise returns the cached layer.

## Auto Parquet Export

Server auto-exports today's DuckDB to Parquet every 5 minutes (`packages/server/src/recorder/index.ts`). Client requests serve the cached file (at most 5 min stale) instead of triggering an on-demand export.

## UI

Toggle in the expandable filter row: a styled chip with a red→yellow→green gradient dot labeled "Congestion". Checkbox hidden, label is the click target. State stored as `heatmapEnabled` in the store.
