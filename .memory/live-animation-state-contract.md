# Live Animation State Contract

_Date: 2026-04-01_

## Purpose

This is a second-pass investigation note for the live animation bug.

It answers:

- what exact state contract live mode should follow
- how that contract should match the good startup/backlog behavior
- where the current implementation violates that contract
- what to verify before and after a fix

**Investigation only. No code changes are described here.**

---

## Core requirement

Live mode must behave like a continuously-extended version of the initial backlog animation.

That means:

- vehicles move along the route shape
- motion is smooth
- motion is **constant velocity between successive live targets**
- trails retract once motion actually stops
- all clients remain in sync because they follow the same authoritative world-state stream

The important design point is:

> Constant velocity is still required in live mode, but it must be derived from the **authoritative live target stream**, not from the semantic vehicle speed field.

---

## Three current data paths

There are currently three conceptually different sources feeding the client animation system.

## 1. Backlog bootstrap

Source:
- WebSocket `init.backlog`

Code path:
- `packages/client/src/ws.ts`
- `packages/client/src/map.ts` → `feedBacklog()`
- `packages/client/src/layers.ts` → `feedBacklog()`

Behavior:
- build a finite queue of historical target distances
- start at oldest target
- move forward through queued targets
- no dependence on per-vehicle GTFS timestamp for the bootstrap segment timing

Observed result:
- smooth
- stable
- trails behave properly

## 2. Live mode

Source:
- WebSocket `tick`

Code path:
- `packages/server/src/index.ts` → `broadcastCycle()`
- `packages/server/src/interpolation/index.ts` → `interpolate()`
- `packages/client/src/ws.ts` → `applyTick()`
- `packages/client/src/map.ts` → store subscriber → `feedTick()`
- `packages/client/src/layers.ts` → `feedTick()` / `computeFrame()`

Behavior today:
- target distances come from server-interpolated live `shapeDistTraveled`
- motion budget uses `anim.speed`
- in live mode `anim.speed` is populated from `VehiclePosition.speed`
- `VehiclePosition.speed` is derived from historical per-vehicle timestamps, not from the broadcast segment timing

Observed result:
- eventually buggy
- arrows stop or jitter
- trails can stay “moving” forever and fail to retract

## 3. Playback mode

Source:
- historical chunk snapshots + vehicle timelines

Code path:
- `packages/client/src/playback.ts`
- `packages/client/src/playback-chunks.ts`
- `applyTick()` → `feedTick()` → `computeFrame()`

Behavior:
- playback also ultimately feeds target positions into the same client animation path
- playback speed multiplier controls how fast the overall world clock advances

Important note:
- the architectural intent is that everything from `applyTick()` onward should share one mental model
- in practice, live mode is still semantically different because it depends on a different timing contract

---

## Desired live contract

## Mental model

A vehicle in live mode should not be modeled as:

> “raw vehicle observation + semantic speed”

It should be modeled as:

> “a sequence of authoritative live route-distance targets emitted on a shared world clock”

The client’s job is then:

1. append each new target segment in order
2. move at constant velocity across that segment
3. when no more motion segments remain, retract the trail

---

## Required state per vehicle

A correct live animation contract should be expressible with state like:

- `lastAppliedSeq`
  - last `WorldState.seq` incorporated for this vehicle
- `segmentStartDist`
  - route distance where the current live segment begins
- `segmentEndDist`
  - route distance where the current live segment ends
- `segmentStartTime`
  - authoritative time the current segment started
- `segmentEndTime`
  - authoritative time the current segment should end
- `queuedSegments[]`
  - future live segments waiting behind the current one
- `currentDist`
  - current animated position on the shape
- `tailDist`
  - current trail tail distance
- `motionState`
  - derived, not necessarily stored:
    - `SEGMENT_ACTIVE`
    - `TRAIL_RETRACTING`
    - `STOPPED`

What should **not** define live motion timing:

- `VehiclePosition.speed`
- `VehiclePosition.timestamp`

Those may still be useful for display, analysis, and congestion, but not as the live animation clock.

---

## Required transitions

## Transition 1 — BootstrapFromBacklog

Input:
- ordered backlog of historical `WorldState`s

State update:
- convert successive backlog positions into an ordered queue of live-style segments
- initialize `currentDist` from the oldest available position
- initialize one or more queued constant-velocity segments from the remaining backlog targets

Key property:
- backlog is just preloaded live history
- it should use the same segment semantics as steady-state live mode

## Transition 2 — AppendLiveTick

Input:
- a new `WorldState` with higher `seq`

Preconditions:
- `seq` must be greater than `lastAppliedSeq`

State update:
- append at most one new target segment for this vehicle for that live tick
- segment duration comes from the authoritative live tick timing contract
- do not derive segment duration from per-vehicle GTFS timestamp deltas

Invariant:
- one live tick contributes at most one new segment per vehicle
- duplicate store updates must not append duplicate segments

## Transition 3 — AdvanceFrame

Input:
- render-frame delta `dt`

State update:
- advance linearly from `segmentStartDist` toward `segmentEndDist`
- progress is determined by elapsed segment time / segment duration
- velocity remains constant within that segment

Invariant:
- no segment-level acceleration/deceleration within a single live segment
- constant velocity is preserved until segment completion

## Transition 4 — CompleteSegment

Precondition:
- current world/render time reaches `segmentEndTime`

State update:
- set `currentDist = segmentEndDist`
- pop next queued segment if present
- if no segments remain, enter trail retraction state

Invariant:
- segment completion is time-based, not dependent on arbitrary catch-up speed

## Transition 5 — RetractTrail

Precondition:
- no active segment
- no queued segments

State update:
- keep `currentDist` fixed
- move `tailDist` toward `currentDist`

Invariant:
- trail retracts if and only if motion is genuinely complete

## Transition 6 — RemoveVehicle

Precondition:
- vehicle absent from new authoritative world state

State update:
- remove live segment state for that vehicle

---

## What “constant velocity” means here

In this system, constant velocity should mean:

> Between two successive authoritative live targets, the vehicle traverses the route-distance delta linearly over the segment’s assigned duration.

So if the live stream says:

- previous target = 12,000 m
- next target = 12,120 m
- segment duration = 1.0 s

then the client should render:

- 12,030 m at 0.25 s
- 12,060 m at 0.50 s
- 12,090 m at 0.75 s
- 12,120 m at 1.00 s

That is constant velocity.

This is different from:

- “advance by semantic transport speed from GTFS timestamps”
- “try to catch up to the newest target using a separate speed budget”

The latter is exactly what appears to be breaking live mode.

---

## Why the current implementation violates the contract

## Violation A — Wrong timing source for live segments

Current live implementation in `packages/client/src/layers.ts`:

- queues route-distance targets from live broadcasts
- advances `currentDist` by `anim.speed * dt`
- in live mode, `anim.speed` is sourced from `v.speed`

Problem:
- `v.speed` is a semantic speed field derived from historical snapshot deltas and per-vehicle GTFS timestamps
- it is not the live segment timing contract

Result:
- client can lag, overrun, or churn around the authoritative target stream

## Violation B — Live identity is keyed to vehicle timestamp, not world tick

Current reducer logic uses `v.timestamp` to coalesce live targets.

Problem:
- `v.timestamp` is a per-vehicle observation timestamp from the GTFS feed
- the server’s live animation stream is emitted on `WorldState.seq` / broadcast time
- many successive live ticks can legitimately share the same vehicle timestamp while the server keeps interpolating new positions

Result:
- the client is making live queue decisions using the wrong identity clock

Correct live identity should be something like:

- `WorldState.seq` for ordering and uniqueness
- plus explicit or authoritative segment timing for duration

## Violation C — Feed ingestion is tied to generic store updates

`packages/client/src/map.ts` uses `store.subscribe()` and calls `feedTick()` on any store change.

Problem:
- unrelated state changes can cause re-entry into the animation reducer
- the animation contract should only advance on new authoritative `WorldState`s

Result:
- live queue mutation is not strictly tied to new world ticks
- reasoning about duplicates becomes harder

This may be a secondary bug, but it is a contract violation nonetheless.

## Violation D — Live segment duration metadata is implicit / underspecified

The current `WorldState` provides:

- `seq`
- `timestamp` (POSIX seconds)

Potential issue:
- `timestamp` is only second-resolution
- live segments need a robust authoritative duration source if the renderer is supposed to preserve constant velocity exactly

This means the eventual fix may require one of the following contracts:

1. use `seq` plus known broadcast interval
2. use `timestamp` if resolution and monotonicity are sufficient
3. add an explicit millisecond tick time / segment time field to `WorldState`

This is not yet an implementation recommendation, only a contract observation.

---

## Exact contract the live path should obey

## Contract statement

For every vehicle in live mode:

1. the server emits an ordered stream of authoritative route-distance targets
2. each new target defines one constant-velocity segment from the previous authoritative target to the new one
3. segment timing is derived from the authoritative live world clock
4. client rendering linearly traverses that segment until its deadline
5. when no segment remains, the trail retracts
6. display speed is separate from animation timing

---

## TLA-style state model

## State variables

Per vehicle:

- `CurrentDist`
- `TailDist`
- `CurrentSegment = null | {StartDist, EndDist, StartTime, EndTime}`
- `QueuedSegments`
- `LastSeq`

Global:

- `CurrentWorldTick`
- `CurrentWorldTime`

## Valid transitions

- `Bootstrap`
- `ReceiveLiveTick`
- `AdvanceFrame`
- `FinishSegment`
- `StartTrailRetract`
- `FinishTrailRetract`
- `DropVehicle`

## Required invariants

### Invariant 1
A vehicle cannot be simultaneously:

- in an active motion segment
- and in trail-retraction-only mode

### Invariant 2
If `CurrentSegment = null` and `QueuedSegments = []`, then the only allowed motion is:

- `TailDist -> CurrentDist`

### Invariant 3
A vehicle’s live segment queue may only change when a new authoritative `seq` is received.

### Invariant 4
Within a single active segment, `CurrentDist` is linear in time.

### Invariant 5
Display speed does not affect live segment completion.

### Invariant 6
Two clients given the same sequence of world ticks must produce the same position curve (modulo frame sampling).

---

## Concrete divergence from the good backlog behavior

The startup backlog currently acts like:

- a prebuilt queue of authoritative positions
- consumed by a simple constant-velocity client animator

The steady-state live path currently acts like:

- append authoritative positions
- but consume them using semantic speed from a different clock

That is the core mismatch.

The correct design is:

> backlog mode and steady-state live mode should be the same machine.

The only difference should be where the future segments come from:

- backlog mode: preload several segments immediately
- live mode: append one segment each new world tick

---

## Proposed no-code plan

## Phase 1 — Instrument the real contract

Before changing behavior, log for a sample of vehicles:

- `WorldState.seq`
- `WorldState.timestamp`
- per-vehicle incoming `shapeDistTraveled`
- current animated `currentDist`
- queue length / active segment count
- distance lag to target
- display speed (`v.speed`)
- whether frame advancement is segment-based or speed-budget-based
- motion state (`SEGMENT_ACTIVE` / `TRAIL_RETRACTING` / `STOPPED`)

Goal:
- prove that the buggy vehicles are violating the contract above

## Phase 2 — Define the authoritative segment timing source

Decide what the live segment duration actually is:

- based on `seq` cadence
- based on world timestamps
- or based on a new explicit tick-time field

This must be explicit before implementation.

## Phase 3 — Unify backlog and live into one segment queue model

Make backlog and live append the same segment type.

The machine should not have:

- one bootstrap contract
- another steady-state live contract

## Phase 4 — Separate display speed from animation timing

Keep `VehiclePosition.speed` for:

- labels
- panel data
- heatmap

But do not let it control live segment consumption.

## Phase 5 — Restrict reducer entry

Ensure the animation feed reducer only runs on new authoritative `WorldState` ticks, not generic store changes.

---

## Validation checklist for the eventual fix

- [ ] backlog bootstrap still looks smooth
- [ ] live mode extends that same motion pattern seamlessly
- [ ] live mode preserves constant velocity per segment
- [ ] stopped vehicles eventually have no active segment and no queued segments
- [ ] trails fully retract after stop
- [ ] irregular GTFS vehicle timestamps no longer cause jitter
- [ ] two tabs remain visually aligned from the same world-state stream
- [ ] playback still shares the same downstream animation contract

---

## Final conclusion

The live bug is not just “an animation tuning issue”.

It is a **state-contract mismatch**:

- backlog mode behaves like a queue of authoritative motion segments
- live mode behaves like authoritative targets chased by a separate semantic speed clock

To make live mode identical to the good startup behavior, the system needs one contract:

> authoritative world-state target stream → constant-velocity segments on the world clock → trail retract only after the segment queue drains

That appears to be the cleanest model consistent with the current architecture and the user-visible requirement.
