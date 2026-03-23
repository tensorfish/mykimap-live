# Animation Architecture

How vehicles animate smoothly — the same system for both live and playback.

---

## Single Pipeline

```
Data source → applyTick(WorldState) → store → feedTick → computeFrame(60fps) → render
```

**Live mode:** WebSocket ticks every 1s → `applyTick`
**Playback mode:** In-memory snapshot array → `advancePlayback(dtMs)` → `applyTick`

Both feed into the same `feedTick` → `computeFrame` → render chain. No separate animation code for playback.

---

## Route-Based Animation

Vehicles don't lerp between raw lat/lon positions (that cuts through buildings). Instead:

1. **Route shape cache** — each vehicle's route shape is fetched once from `/api/route-shape/:tripId` and cached as `{ path: [lon,lat][], dists: number[] }`.

2. **Shape snapping** — `clientSnapToShape(vehicle)` projects the raw GPS position onto the nearest point on the cached shape, returning a `shapeDist` (meters along the route). This works for both live data (which has server-computed `shapeDistTraveled`) and playback data (which has raw GPS with `shapeDistTraveled = -1`).

3. **Animation state** — each vehicle has a `VehicleAnim`:
   - `currentDist` — where the arrow IS right now (meters along shape)
   - `targetDist` — where it should be (from latest data)
   - `tailDist` — where the trail tail is
   - `speed` — meters/second, inferred from consecutive positions
   - `direction` — +1 or -1 along shape

4. **Per-frame advancement** — `computeFrame(dtMs)` advances `currentDist` toward `targetDist` at `speed`. Position is sampled from the shape at `currentDist`. The arrow follows every curve of the route.

5. **Bearing** — computed from two points on the shape near `currentDist` (10m behind and current). Always correct regardless of shape polyline direction.

6. **Trail** — `tailDist` follows the arrow at the same speed, maintaining 800m behind. When the arrow stops, the tail catches up ("eats itself"). Trail is a slice of the actual route shape from `tailDist` to `currentDist`.

---

## Speed Multiplier

One function controls all animation speed:

```ts
getAnimationSpeedMultiplier():
  live mode → 1
  playback playing → playback.speed (1, 10, 60, 360)
  playback paused → 0 (freezes everything)
```

The single render loop in `map.ts` calls `computeFrame(dtMs * multiplier)`. At 60× playback, vehicles traverse 30s of route distance in 0.5s of real time.

---

## Single Render Loop

One `requestAnimationFrame` loop in `map.ts`:

```ts
function renderFrame(now) {
  dtMs = now - lastFrameTime;
  advancePlayback(dtMs);          // no-op in live mode
  display = computeFrame(dtMs * speedMult);
  deck.setProps({ layers: [...] });
  requestAnimationFrame(renderFrame);
}
```

No second rAF loop for playback. `play()` and `pause()` just set boolean flags.

---

## Data Flow Detail

### Live mode

```
GTFS-RT feed (every ~30s)
  → server processSnapshot (snap to shapes, calculate speed)
  → server interpolate (30s delayed playback, advance along shape)
  → broadcast via WebSocket (every 1s)
  → client applyTick → store
  → feedTick: update animation target from shapeDistTraveled
  → computeFrame: advance arrow along shape at 60fps
  → render: arrows + trails + route shapes
```

### Playback mode

```
DuckDB recording (Parquet file)
  → client loads ALL snapshots into memory
  → advancePlayback: advance timestamp, feed snapshot when crossed
  → applyTick → store
  → feedTick: clientSnapToShape (raw GPS → shapeDist), update target
  → computeFrame: advance arrow along shape at 60fps × speed multiplier
  → render: arrows + trails + route shapes
```

The only difference is the first three steps. Everything from `feedTick` onward is identical.

---

## Client-Side Shape Snapping

Playback data is raw GPS (no server processing). `clientSnapToShape()` in `layers.ts` snaps the raw lat/lon to the cached route shape:

1. For each segment of the shape polyline, project the vehicle's position onto the segment
2. Find the nearest projection
3. Return the cumulative distance at that point

This is the same algorithm as the server's `snapToShape()` but runs on the client using the cached shape from `/api/route-shape`.

---

## On-Load Animation

When the page loads:

1. Server sends 15-tick backlog on WebSocket connect
2. `feedBacklog` processes all ticks, places arrows at the oldest position
3. Speed set to traverse the full backlog distance in 3 seconds
4. Arrows immediately glide along their routes — visible movement from frame 1

---

## Why This Works

- **No prediction** — server uses 30s delayed playback, interpolating between two known positions
- **No dual animation** — one render loop, one animation system, one speed control
- **Route-following** — all positions sampled from GTFS shape polylines
- **Trail from shape** — always on the road, never cuts through buildings
- **Bearing from movement** — computed from shape geometry at the arrow's position
