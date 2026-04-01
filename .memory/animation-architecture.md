# Animation Architecture

How vehicles animate smoothly — the same system for both live and playback.

---

## Single Pipeline

```
Data source → applyTick(WorldState) → store → feedWorldState(WorldState) → computeFrame(60fps) → render
```

**Live mode:** WebSocket ticks every 1s → `applyTick`
**Playback mode:** In-memory snapshot array → `advancePlayback(dtMs)` → `applyTick`

Both feed into the same `feedWorldState` → `computeFrame` → render chain. No separate animation code for playback.

---

## Route-Based Animation

Vehicles don't lerp between raw lat/lon positions (that cuts through buildings). Instead:

1. **Route shape cache** — each vehicle's route shape is fetched once from `/api/route-shape/:tripId` and cached as `{ path: [lon,lat][], dists: number[] }`.

2. **Shape snapping** — `clientSnapToShape(vehicle)` projects the raw GPS position onto the nearest point on the cached shape, returning a `shapeDist` (meters along the route). This works for both live data (which has server-computed `shapeDistTraveled`) and playback data (which has raw GPS with `shapeDistTraveled = -1`).

3. **Animation state** — each vehicle has a `VehicleAnim`:
   - `currentDist` — where the arrow IS right now (meters along shape)
   - `tailDist` — where the trail tail is
   - `segments[]` — queued motion segments, each `{ startDist, endDist, durationMs, elapsedMs }`
   - `direction` — +1 or -1 along shape
   - `displaySpeed` — semantic speed shown in the UI. Used for labels/heatmap, **not** as the live animation clock.

   Every `WorldState` also carries `tickTimeMs` — the authoritative world time for that tick. Live mode uses server emit time. Playback uses simulated world time (`snapshot.timestamp * 1000`).

   Derived motion states:
   - `SEGMENT_ACTIVE` — there is at least one active or queued motion segment
   - `TRAIL_RETRACTING` — no remaining segments, but `tailDist` has not yet caught up to `currentDist`
   - `STOPPED` — no remaining segments and `tailDist === currentDist`

4. **Per-frame advancement** — `computeFrame(dtMs)` advances through motion segments at constant velocity. For each segment, position is linear in time between `startDist` and `endDist` for exactly `durationMs`. The render loop passes `dtMs × speedMultiplier`, so playback compresses or expands world time without changing the segment logic.

   Live contract: each new authoritative `WorldState` appends at most one new motion segment per vehicle. Segment duration comes from `tickTimeMs` deltas on the world clock — **not** from per-vehicle GTFS timestamps or semantic `speed`.

5. **Bearing** — computed from two points on the shape near `currentDist` (10m behind and current). Always correct regardless of shape polyline direction.

6. **Trail** — `tailDist` follows the arrow at the current segment's velocity, maintaining 800m behind while motion is active. When the segment queue drains, the tail catches up ("eats itself"). Trail is a slice of the actual route shape from `tailDist` to `currentDist`.

   Invariant: trail retraction begins only when there is no active segment and no queued future segment. Live mode must never be left in a pseudo-moving state by semantic speed drift.

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
  try {
    dtMs = Math.min(now - lastFrameTime, 100); // capped at 100ms
    advancePlayback(dtMs);          // no-op in live mode
    display = computeFrame(dtMs * speedMult);
    deck.setProps({ layers: [...] });
  } catch (e) {
    console.error(e);
  } finally {
    requestAnimationFrame(renderFrame); // ALWAYS reschedule
  }
}
```

**Defensive measures:**
- **dtMs capped at 100ms** — prevents huge time jumps after the tab was backgrounded (rAF pauses but WebSocket keeps delivering data, so targets accumulate).
- **`visibilitychange` listener** — resets `lastFrameTime` when the tab becomes visible, so the first frame after restore gets a clean delta instead of minutes.
- **try/finally** — an unhandled exception must never kill the render loop. The `requestAnimationFrame` call is in the `finally` block.
- **Store subscriber try/catch** — `feedWorldState` errors are caught so they don't break the TanStack Store subscription chain.

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
  → feedWorldState: append constant-velocity motion segments from `shapeDistTraveled` + `tickTimeMs`
  → computeFrame: advance arrow along shape at 60fps on the world clock
  → render: arrows + trails + route shapes
```

### Playback mode (YouTube-style streaming)

```
User picks date
  → fetch metadata (~1 KB) — slider is interactive immediately
  → load first 30-min chunk (~4–13 MB Parquet)
  → chunk manager: register in DuckDB-WASM, decode, build timelines
  → advancePlayback: advance timestamp, feed snapshot when crossed
  → applyTick → store
  → feedWorldState: clientSnapToShape (raw GPS → shapeDist), append motion segments
  → computeFrame: advance arrow along shape at 60fps × speed multiplier
  → render: arrows + trails + route shapes

While playing:
  → prefetch next chunk when approaching buffer edge
  → if playback outruns buffer → inline "Buffering..." (not full-screen modal)
  → evict old chunks (LRU, max 4 loaded)

Seek to unloaded time:
  → inline buffer indicator → fetch chunk → resume
```

Playback does **not** download the entire day's Parquet upfront. The chunk manager (`playback-chunks.ts`) streams 30-minute chunks on demand. A buffer bar on the slider shows loaded ranges (like YouTube's gray bar).

The only difference from live mode is the first steps (metadata → chunk → decode). Everything from `feedWorldState` onward is identical.

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
2. `feedBacklog` replays all backlog `WorldState`s into the same motion-segment queue used by live mode
3. The arrow starts at the oldest observed position and receives preloaded world-clock segments
4. Arrows immediately glide along their routes — visible movement from frame 1

---

## Why This Works

- **No prediction** — server uses 30s delayed playback, interpolating between two known positions
- **No dual animation** — one render loop, one animation system, one speed control
- **Route-following** — all positions sampled from GTFS shape polylines
- **Trail from shape** — always on the road, never cuts through buildings
- **Bearing from movement** — computed from shape geometry at the arrow's position
