# UI Stabilizing: Root Cause Analysis

Three symptoms: arrows snap into position, trail goes off-route, arrows point wrong direction. Here's every root cause and the fix for each.

---

## Bug 1: Route shape direction mismatch (causes wrong bearing + off-route trail)

**Root cause:** `getShapeForRoute()` returns the **first** shape found for a route_id. Each route has 20–76 shape variants — `.H` (direction 0) and `.R` (direction 1) plus sub-variants for short-runs and diversions. If the vehicle is traveling direction 1 (Return) but the fallback picks a direction 0 (Homebound) shape, everything goes wrong:
- The vehicle snaps to the wrong track (parallel but slightly offset)
- The `shapeDist` delta between polls can flip sign (wrong direction detection)
- Bearing is derived from the wrong shape → 180° flipped or at an angle
- Trail follows the wrong shape → appears off-route

**Affects:** All trams (100% use route fallback), and any bus/train where the trip_id didn't match.

**Fix:** Store both shapes per route (one per direction_id). When a vehicle first appears, try both shapes — pick the one where the snap distance is smallest (closest to the actual GPS position). Store the chosen direction with the vehicle state and reuse it.

---

## Bug 2: `bearingAtDist` fallthrough bug (causes wrong bearing at shape edges)

**Root cause:** The for-loop in `bearingAtDist` has an in-loop fallthrough:
```
for (let i = 0; i < shape.length - 1; i++) {
  if (dist >= shape[i].dist && dist <= shape[i+1].dist) {
    a = shape[i]; b = shape[i+1]; break;
  }
  a = shape[shape.length - 2]; // BUG: overwrites on every non-match
  b = shape[shape.length - 1];
}
```
If `dist` is before the shape start (e.g. clamped to 0 but first shape point starts at 0.01), the loop doesn't match any segment, and the fallthrough returns the **last** segment instead of the first. This gives a bearing from the terminus end of the route — completely wrong.

**Fix:** Remove the in-loop fallthrough. Search first, then fall back to first/last segment outside the loop.

---

## Bug 3: Server interpolation overshoots shape bounds (causes snapping)

**Root cause:** In `interpolate()`, the elapsed time since `receivedAt` grows continuously until the next `processSnapshot`. With a 15s poll interval and 1s broadcasts, `elapsedSec` can reach 15+. At 20 m/s speed, that's 300+ meters of advance. But `receivedAt` is set during `processSnapshot`, and between fresh polls the state is never updated (duplicate polls are skipped). So the vehicle keeps advancing along the shape, potentially reaching the terminus, then on the next fresh poll it snaps back to its actual position. That's the "snap".

**Fix:** Cap elapsed time to a reasonable maximum (e.g. 2× broadcast interval). After that, hold position until the next fresh poll arrives. Alternatively, update `receivedAt` on every broadcast tick so elapsed is always ~1s.

---

## Bug 4: Client lerp promotes wrong previous position (causes micro-teleports)

**Root cause:** In `updateLerpTargets()`, when a new server tick arrives, the current position becomes `prev` and the new position becomes `cur`. But the "current position" at that moment is the **server-interpolated** position from the last tick, which has already been advanced forward. The lerp then goes from an advanced position to a new anchor — which could be behind or to the side if the shape curves. This creates micro-teleports on every tick.

**Fix:** The lerp `prev` should be the vehicle's **last displayed position** (the lerp output from the previous frame), not the server's last sent position. This way the lerp always goes from where the arrow actually was on screen to where it should be now.

---

## Bug 5: Trail appended from interpolated positions (causes off-route trail)

**Root cause:** In `interpolate()`, the trail is appended from positions sampled along the shape. If the shape is wrong (Bug 1) or the interpolation overshoots (Bug 3), the trail records bad positions. But even with correct shapes, the trail is appended every broadcast tick (1s), giving ~30-80 points. If the vehicle turns a corner between polls, the interpolation advances in a straight line along the shape from the old position, potentially cutting the corner. The trail records this straight cut.

**Fix:** Trail should only be appended from **actual poll positions** (the snapped GPS data), not from interpolated positions. Poll data arrives every ~30s (when the feed cache refreshes), which gives fewer trail points but they're all on the road. Interpolated positions should only affect the arrow display, not the trail.

---

## Decisions

### Architecture: server interpolates, client lerps between ticks

The server advances vehicles along shapes and broadcasts every 1s. The client lerps between consecutive server ticks at 60fps. No client-side projection (that caused double-movement bugs). No deck.gl transitions (that caused splattering).

### Shape matching: both directions per route

Store `routeToShapesByDirection: Map<routeId, { dir0: shapeId, dir1: shapeId }>`. On first vehicle sighting, snap to both shapes, pick closest. Store chosen direction in vehicle state.

### Bearing: always from shape at interpolated position + direction

Never from raw GPS deltas (too noisy). Never from trail (circular dependency). Always from the shape geometry at the current interpolated distance, flipped 180° if direction is -1.

### Trail: from poll data only

Append to trail in `processSnapshot()` (on fresh data), never in `interpolate()`. Trail points are real GPS-snapped positions. Fewer points but all valid.

### Interpolation: cap elapsed time

After advancing `speed × min(elapsed, 2 × broadcastInterval)`, hold position. Prevents runaway advance during long poll gaps.

### Client lerp: from last displayed position

`updateLerpTargets()` should record where the arrow currently IS on screen (the lerp output), not where the server last said it was. This makes every transition start from the visible position — no micro-teleport.

---

## Fix order

1. Fix `bearingAtDist` loop (trivial)
2. Store both shape directions per route, pick closest on first snap
3. Move trail append from `interpolate()` to `processSnapshot()` only
4. Cap interpolation elapsed time
5. Fix client lerp to use last displayed position as prev
6. Test each fix independently
