# UI Stabilizing: TLA+ State Analysis & Architectural Fix

---

## 1. State Variables

```
VehicleState = {
  position: [lon, lat]       — where the vehicle actually is (from feed)
  displayPosition: [lon, lat] — where the arrow is on screen right now
  shapeDist: number           — distance along matched shape polyline
  shape: ShapePolyline | null — which shape this vehicle is matched to
  shapeDirection: +1 | -1     — travel direction along shape
  speed: number               — m/s, derived from consecutive polls
  bearing: number             — degrees, derived from shape + direction
  lastPollTime: timestamp     — when the last real GPS position arrived
  trail: [lon, lat][]         — recent positions for the snail trail
}
```

There are **three position concepts** in the system right now, and confusion between them is the root of every bug:

| Position | What it is | Source |
|---|---|---|
| **Feed position** | Raw GPS from GTFS-RT, snapped to shape | `processSnapshot()`, every ~30s |
| **Server interpolated position** | Feed position advanced along shape by speed × elapsed | `interpolate()`, every 1s |
| **Client display position** | Server position lerped from previous tick | `computeFrame()`, every 16ms |

**The architectural bug: there are two levels of speculation on top of one ground truth.** The server speculates where the vehicle is between polls. The client speculates where it is between server ticks. Each speculation compounds errors from the previous one.

---

## 2. Transitions

```
FeedPoll (every ~30s, when feed cache refreshes)
  precondition: fresh data (header timestamp changed)
  state change:
    position = snap(rawGPS, shape)
    speed = |shapeDist - prevShapeDist| / dt
    direction = sign(shapeDist - prevShapeDist)
    bearing = shapeSegmentBearing(shapeDist, direction)
    lastPollTime = now

ServerBroadcast (every 1s)
  precondition: server is RUNNING
  state change:
    elapsed = now - lastPollTime
    advancedDist = shapeDist + speed × elapsed × direction
    interpolatedPos = sampleShape(advancedDist)
    → send to client

ClientTick (every 16ms / 60fps)
  precondition: has received ≥ 1 server tick
  state change:
    t = elapsed since last server tick / 1000ms
    displayPosition = lerp(prevServerPos, curServerPos, t)
    → render arrow at displayPosition
```

---

## 3. Invariants

```
I1: displayPosition must be on or very near (<50m) the vehicle's route
I2: bearing must match the direction the arrow visually moves
I3: trail must lie on the route geometry
I4: displayPosition must change smoothly (no teleports > 50m between frames)
I5: when a vehicle is stationary, displayPosition must not drift
```

---

## 4. Counterexample Traces (each one breaks an invariant)

### Trace A: Overshoot → snap back (breaks I4)

```
1. FeedPoll: position at shapeDist=1000m, speed=15m/s
2. ServerBroadcast (t=1s): advance to 1015m → send
3. ServerBroadcast (t=2s): advance to 1030m → send
   ...
4. ServerBroadcast (t=14s): advance to 1210m → send
5. FeedPoll: new position at shapeDist=1180m (actual moved 180m in 15s = 12m/s)
6. ServerBroadcast: advance from 1180m → send 1180m
   
   Client sees: tick N at 1210m, tick N+1 at 1180m → arrow jumps BACKWARD 30m
```

The server accumulated 14s of overshoot at 15m/s but the actual speed was 12m/s.

### Trace B: Wrong shape direction (breaks I1, I2)

```
1. Tram appears on route 96 going east
2. getShapeForRoute picks shape 3-96-vpt-10.2.R (westbound)
3. snapToShape finds nearest point on WRONG TRACK
4. shapeDist = 5000m on westbound shape
5. Next poll: tram moved east → on westbound shape, shapeDist DECREASES to 4900m
6. direction = -1 (correct for the wrong shape, wrong for reality)
7. bearing from westbound shape + direction -1 = EAST (accidentally correct)
8. BUT: the snap position is on the wrong track (30m off)
   Trail records wrong-track positions → appears off-route
```

### Trace C: Client lerp from wrong prev (breaks I4)

```
1. Server tick N: sends position at [144.96, -37.81] (shapeDist 1000m)
2. Client lerp state: prev = [144.96, -37.81], cur = [144.96, -37.81]
3. Client renders at [144.96, -37.81]
4. Server tick N+1: sends position at [144.9601, -37.8101] (shapeDist 1015m, 15m east)
5. Client lerp: prev = [144.96, -37.81] (old cur), cur = [144.9601, -37.8101]
   → lerps from OLD SERVER position to NEW SERVER position
   BUT: the arrow was DISPLAYED at the lerp output from frame 59 of the previous tick,
   which was at cur (= [144.96, -37.81] — same as prev!)
   → lerp starts from the right place by accident
   
   UNLESS the server's interpolated position in tick N was AHEAD of where
   tick N+1 starts (overshoot):
   
4'. Server tick N+1: sends [144.9599, -37.8099] (new poll snapped back)
5'. Client lerp: prev = [144.96, -37.81], cur = [144.9599, -37.8099]
    → arrow lerps BACKWARD
```

### Trace D: Stationary vehicle drifts (breaks I5)

```
1. Vehicle stops at shapeDist=5000m, speed=8m/s (from previous movement)
2. Feed doesn't update (same timestamp → duplicate poll skipped)
3. processSnapshot carries forward speed=8m/s
4. interpolate() advances: 5000 + 8 × elapsed → vehicle drifts forward
5. Next fresh poll: vehicle still at 5000m → snap back
```

---

## 5. The Real Architectural Problem

The system has **three moving parts that are all trying to predict the future independently**:

1. Server `interpolate()` predicts between polls (30s gaps)
2. Client `computeFrame()` predicts between server ticks (1s gaps)
3. Feed data is the only ground truth, but it's 30s stale

Each prediction layer amplifies errors from the layer below it. The client lerps between two server-predicted positions, both of which may be wrong.

**The fix is not to patch each bug individually. The fix is to collapse the prediction stack to one layer.**

---

## 6. Architectural Decision: Single-Layer Prediction

**Only ONE component predicts. Everything else passes through data.**

### Option A: Server predicts, client renders directly (no lerp)

Server broadcasts at 1s. Client renders exactly what it receives. Movement appears as 1-step-per-second.

❌ Too choppy. 1fps effective animation.

### Option B: Server passes through, client predicts

Server sends raw poll data (every ~30s). Client does all interpolation at 60fps.

❌ Client doesn't have shape data. Would need to download shapes (huge). And client-side shape interpolation was tried and caused issues.

### Option C: Server predicts to next beat, client lerps ONLY between beats ✅

**Server broadcasts the PREDICTED position for the NEXT tick** (1s in the future), not the current interpolated position. Client lerps from current display position to the predicted position over 1s at 60fps.

This way:
- Server prediction is bounded: it only looks 1s ahead, never 15s
- Client lerp is always forward: from where the arrow IS to where it WILL BE
- No overshoot: the server advances exactly 1s of movement per tick
- If the feed corrects the position, the correction is folded into the next predicted position — no snap

```
Server tick N:
  currentDist = vehicle's shapeDist (from last poll or previous prediction)
  predictedDist = currentDist + speed × 1s × direction
  predictedPos = sampleShape(predictedDist)
  predictedBearing = bearingAtDist(predictedDist, direction)
  → broadcast predictedPos + predictedBearing

  On next tick, advance currentDist to predictedDist (it becomes the new baseline).
  On fresh poll, replace currentDist with the actual snapped shapeDist.

Client:
  On receive tick N:
    prev = lastDisplayPosition (where arrow IS on screen right now)
    target = predictedPos from server
  Every frame:
    t = elapsed / 1000ms
    display = lerp(prev, target, t)
    render arrow at display
```

### Why this works:

- **No overshoot**: server advances exactly 1s per beat, never accumulates
- **No snap-back**: fresh poll data folds into the next prediction seamlessly
- **Client always lerps forward**: prev is always the on-screen position
- **Trail from poll data**: only real GPS-snapped positions, always on route
- **Bearing from shape**: at the predicted point, with correct direction

---

## 7. Shape Direction Fix

The route fallback (`getShapeForRoute`) must store **both directions**:

```
routeToShapes: Map<routeId, { dir0: ShapePolyline, dir1: ShapePolyline }>
```

On first vehicle sighting:
1. Snap GPS to dir0 shape → get snap distance d0
2. Snap GPS to dir1 shape → get snap distance d1
3. Pick the shape with the smaller snap distance
4. Store the chosen shape + direction with the vehicle

On subsequent polls:
- Reuse the same shape (don't re-pick every poll — direction doesn't change mid-trip)

---

## 8. Revised Server State

```
VehicleState = {
  shapeDist: number         — last known position on shape (from poll or last beat)
  speed: number             — from poll deltas
  direction: +1 | -1        — from poll shapeDist delta sign
  shape: ShapePolyline      — locked on first sighting
  lastPollShapeDist: number — ground truth from last feed update
}
```

### Server beat cycle (every 1s):

```
BroadcastBeat:
  for each vehicle:
    if stale or speed < 0.5:
      → broadcast current position (no advancement)
    else:
      predictedDist = shapeDist + speed × 1s × direction
      clamp predictedDist to [0, shapeLength]
      predictedPos = sampleShape(predictedDist)
      predictedBearing = bearingAtDist(predictedDist, direction)
      shapeDist = predictedDist  // advance the baseline for next beat
      → broadcast predictedPos + predictedBearing
```

### On fresh poll:

```
FreshPoll:
  newSnappedDist = snapToShape(rawGPS, shape)
  speed = |newSnappedDist - lastPollShapeDist| / dt
  direction = sign(newSnappedDist - lastPollShapeDist)
  shapeDist = newSnappedDist  // reset baseline to ground truth
  lastPollShapeDist = newSnappedDist
  append trail from snapped position
```

### Invariant check:

```
I1: predictedPos = sampleShape(predictedDist) → always on shape ✓
I2: bearing = bearingAtDist(predictedDist, direction) → always from shape ✓
I3: trail only from snapped poll positions → always on route ✓
I4: client lerps from display to predicted (max 1s of movement) → small steps ✓
I5: stale/stationary vehicles: shapeDist not advanced → no drift ✓
```

### Counterexample re-check:

**Trace A (overshoot):** Can't happen. Server advances exactly 1s per beat. Even if the speed was wrong, the error is at most `|speedError × 1s|` ≈ a few meters. On next fresh poll, shapeDist resets to ground truth.

**Trace B (wrong shape):** Fixed by dual-direction shape storage + closest-snap selection.

**Trace C (lerp backward):** Can't happen. Client prev is always the on-screen position. Target is always 1s ahead. Lerp is always forward (unless the server sends a position behind — which only happens on fresh-poll correction, and even then the correction is bounded to ~1s of movement).

**Trace D (stationary drift):** Can't happen. `speed < 0.5` → no advancement.

---

## 9. Implementation Changes Required

### Server

1. **`shapes/loader.ts`**: Store both direction shapes per route:
   `routeToShapes: Map<routeId, Map<directionId, shapeId>>`

2. **`interpolation/index.ts`**: Complete rewrite of VehicleState:
   - `shapeDist` is the current baseline (advanced by 1s per beat)
   - `lastPollShapeDist` for ground truth reset
   - `shape` locked on first sighting (no re-lookup every tick)
   - `interpolate()` advances by exactly 1s and updates baseline
   - Trail appended only in `processSnapshot()`

3. **`bearingAtDist`**: Fix the loop (search then fallback)

### Client

4. **`layers.ts`**: `updateLerpTargets()` sets `prev` to the last computed display position (from `computeFrame` output), not to the last server position

5. **`map.ts`**: No structural change — rAF loop with `computeFrame` stays

### What doesn't change

- WebSocket protocol (still sends `WorldState` with vehicles + trails)
- Store structure
- Panel, UI, selection
- Trail layer rendering
- Route shape layer
