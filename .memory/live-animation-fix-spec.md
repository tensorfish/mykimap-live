# Live Animation Fix Specification

_Date: 2026-04-01_
_Status: Investigation complete. Implementation spec only. No code changes yet._

## Purpose

This document consolidates:

- `.memory/live-animation-bug-investigation.md`
- `.memory/live-animation-state-contract.md`

into a single implementation-oriented spec for fixing the live animation bug.

---

## Problem statement

The initial backlog/bootstrap animation looks correct:

- arrows move smoothly
- motion appears constant
- trails retract properly when vehicles stop

But steady-state live mode degrades over time:

- arrows stop moving or lag
- some vehicles jitter
- snail trails fail to retract

The intended behavior is:

> Live mode must behave like a continuously-extended version of the working backlog/bootstrap animation.

That includes:

- route-following motion
- constant velocity between successive live targets
- clean stop behavior
- trail retraction only after movement has actually completed

---

## Root cause hypothesis

The current live path mixes two incompatible timing models.

### Model A — authoritative live world clock

The server broadcasts already-interpolated target positions:

- one `WorldState` approximately every second
- each contains authoritative `shapeDistTraveled`
- these positions are already derived from the server’s canonical interpolation timeline

### Model B — semantic vehicle speed clock

The client currently advances toward live targets using `VehiclePosition.speed`.

That speed is derived from:

- historical snapshot deltas
- per-vehicle GTFS timestamps
- variable freshness per vehicle

This speed is useful as:

- a transport-speed estimate
- display data
- congestion input

But it is likely **not** the correct timing source for consuming the authoritative live target stream.

### Conclusion

The live bug is most likely caused by using:

- **authoritative live targets**
- with a **non-authoritative semantic speed budget**

This breaks the state machine that backlog/bootstrap appears to satisfy.

---

## Design goal

Unify backlog and live mode under one animation contract:

> authoritative route-distance targets → constant-velocity motion segments on the world clock → trail retract only after segment queue drains

---

## Requirements

## Functional requirements

1. **Live mode must preserve constant velocity.**
   - not snapping
   - not variable-speed catch-up
   - not semantic-speed chase behavior

2. **Live mode must match backlog/bootstrap behavior.**
   - same feel
   - same stop behavior
   - same trail behavior

3. **Live mode must remain server-authoritative.**
   - two tabs should stay in sync
   - client should not invent independent timing

4. **Trails must retract only after motion is complete.**
   - no permanent pseudo-moving state

5. **Playback must still fit the same downstream animation model.**
   - `applyTick(WorldState)` remains the seam

## Non-functional requirements

1. Keep `WorldState` as the interchange format.
2. Do not make rendering depend on WebSocket liveness.
3. Preserve route-shape-based rendering.
4. Keep `VehiclePosition.speed` available for UI/analytics.

---

## Required animation contract

## Mental model

For each vehicle, the client should animate a queue of **motion segments**, not a queue of raw distances chased by semantic speed.

A motion segment is conceptually:

- `startDist`
- `endDist`
- `startTime`
- `endTime`

The client computes the displayed position by linear progress through the current segment.

### Constant velocity definition

Within a single segment:

- distance changes linearly with time
- no acceleration/deceleration
- no variable-speed catch-up

When the segment ends:

- snap exactly to `endDist`
- start the next segment if present
- otherwise begin trail retraction

---

## Unified contract for backlog and live

## Backlog/bootstrap

Backlog should be treated as:

- a preloaded list of authoritative historical segments

The client should:

- initialize the vehicle at the oldest backlog target
- enqueue the remaining backlog segments
- animate them using the same segment logic as live mode

## Live mode

Each new live `WorldState` should:

- append at most one new authoritative segment per vehicle
- segment timing must come from the live world clock contract
- not from `VehiclePosition.timestamp`
- not from `VehiclePosition.speed`

The only difference between backlog and live should be:

- backlog preloads many future segments immediately
- live appends one segment at a time as new ticks arrive

---

## State model

## Per-vehicle state (target design)

Required conceptual state:

- `currentDist`
- `tailDist`
- `activeSegment | null`
- `queuedSegments[]`
- `lastAppliedSeq`

Where:

- `activeSegment = { startDist, endDist, startTime, endTime }`

Optional derived values:

- `direction`
- `motionState`

### Derived motion states

- `SEGMENT_ACTIVE`
- `TRAIL_RETRACTING`
- `STOPPED`

### State invariants

1. A vehicle cannot be both segment-active and retract-only.
2. If there is no active segment and no queued segment, only the tail may move.
3. A new live segment may only be appended when a new authoritative world tick is processed.
4. Within an active segment, position must be linear in time.
5. Trail retraction may only begin when segment queue is empty.

---

## What must stop controlling live animation

These should **not** define live segment timing:

- `VehiclePosition.speed`
- `VehiclePosition.timestamp`

These may continue to be used for:

- vehicle info panel
- displayed speed labels
- congestion heatmap
- analytics/debugging

---

## Authoritative timing source

This must be made explicit in implementation.

Possible choices:

1. `WorldState.seq` + known broadcast interval
2. `WorldState.timestamp` + inferred delta
3. an explicit future tick-time field added to `WorldState`

### Requirement

Whichever source is chosen, it must be:

- shared across all vehicles in the tick
- monotonic
- the same for all clients
- suitable for defining constant-velocity segment durations

### Current assessment

The implementation should prefer the **authoritative world/broadcast timing source**, not vehicle-local GTFS timestamps.

---

## Current contract violations to address

1. **Live target timing is derived from semantic speed.**
   - likely root cause of lag/jitter/stuck trails

2. **Live target identity/coalescing is based on vehicle timestamp.**
   - wrong clock for authoritative live interpolation

3. **`feedTick()` runs from generic store subscription, not only on new world ticks.**
   - increases chance of duplicate or unintended reducer entry

4. **Backlog and live do not currently share the same true segment semantics.**
   - they only superficially share pipeline functions

---

## Proposed implementation plan

## Phase 1 — Instrumentation

Before changing behavior, add temporary debug instrumentation for a sample of vehicles.

Record:

- incoming `WorldState.seq`
- incoming `WorldState.timestamp`
- incoming `shapeDistTraveled`
- current animated position
- active segment / queue length
- target lag
- displayed `speed`
- motion state
- trail state

Goal:
- confirm that buggy vehicles are stuck in a pseudo-moving state or mismatched segment timing state

## Phase 2 — Define live segment timing contract

Pick and document the authoritative timing source for live segments.

Deliverable:
- exact rule for `segmentStartTime` / `segmentEndTime`

## Phase 3 — Convert backlog to explicit motion segments

Make backlog bootstrap build the same motion-segment structure that live mode will use.

Deliverable:
- one segment queue model for both bootstrap and live

## Phase 4 — Convert live tick ingestion to segment append

Each new authoritative world tick should append a segment, not mutate a generic target queue driven by semantic speed.

Deliverable:
- per-vehicle active segment + queued segments
- live motion based on world-clock timing only

## Phase 5 — Separate display speed from animation timing

Keep `VehiclePosition.speed` for UI/analytics only.

Deliverable:
- animation no longer depends on semantic speed in live mode
- panel/labels still show speed

## Phase 6 — Restrict reducer entry to new world ticks

Ensure animation ingestion only occurs when a new authoritative `WorldState` arrives.

Deliverable:
- no feed mutation from unrelated store updates

## Phase 7 — Validate trail state machine

Verify:

- segment queue drains correctly
- retract state begins exactly when it should
- trail completes retraction after stop

---

## Risks / open questions

1. **Tick timing precision**
   - is second-resolution `WorldState.timestamp` sufficient?
   - or is an explicit millisecond tick field needed?

2. **Short-term jitter in incoming live targets**
   - if successive authoritative targets themselves are noisy, constant-velocity segments may still look odd
   - need instrumentation first before deciding whether smoothing is required

3. **Vehicles appearing/disappearing mid-stream**
   - segment state must handle joins/leaves cleanly

4. **Playback compatibility**
   - playback likely already fits the segment model better than live
   - still must confirm no regression in seek/pause/buffer transitions

---

## Success criteria

The fix is successful when:

- [ ] live mode visually matches backlog/bootstrap behavior
- [ ] vehicles move at constant velocity between live targets
- [ ] no arrows freeze while targets continue updating
- [ ] no visible jitter caused by GTFS timestamp irregularity
- [ ] trails retract fully after vehicles stop
- [ ] two tabs stay in sync
- [ ] playback still works through the same downstream animation model

---

## Final statement

This is not primarily a rendering bug.

It is an **animation state contract bug**.

The correct fix is to make live mode obey the same conceptual machine as backlog/bootstrap:

> authoritative live targets become constant-velocity world-clock segments; semantic vehicle speed remains display data only.
