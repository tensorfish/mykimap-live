# Live Animation Bug Investigation

_Date: 2026-04-01_

## Status

Investigation only. **No code changes were made as part of this note.**

This document records the current hypothesis for why live mode diverges from the smooth startup/backlog behavior, plus a proposed plan to fix it.

---

## User-visible symptom

The client behaves well during the initial backlog bootstrap:

- arrows animate smoothly
- motion looks continuous
- snail trails retract correctly when vehicles stop

But once regular live ticks continue arriving, the behavior degrades:

- some arrows stop moving
- some arrows jitter
- some snail trails never retract

Desired behavior:

> Live mode should behave the same way as the initial backlog/bootstrap path: constant, smooth motion along the route shape, with the trail retracting once the vehicle stops.

Additional clarified requirement:

> In live mode, vehicles must also move at **constant velocity** between live updates. The fix must preserve constant-velocity motion; it should not degenerate into snapping or variable-speed catch-up behavior.

---

## Executive summary

### Main hypothesis

The client is mixing **two incompatible clocks** in live mode:

1. **Target positions** come from the server's canonical broadcast clock
   - `packages/server/src/interpolation/index.ts`
   - `packages/server/src/index.ts`
   - server broadcasts a new `shapeDistTraveled` every ~1s
   - those positions are already interpolated on the server using **header timestamp / playback time**, not per-vehicle timestamp deltas

2. **Animation speed** in the client is taken from `VehiclePosition.speed`
   - `packages/client/src/layers.ts` → `feedTick()` / `computeFrame()`
   - in live mode this `v.speed` is server-computed from **per-vehicle GTFS timestamps** over recent snapshots
   - those per-vehicle timestamps have highly variable freshness and do **not** share the same clock as the 1s broadcast interpolation path

As a result, the client is chasing server-interpolated positions using a motion budget derived from a different time base.

That mismatch explains all three symptoms:

- **Arrow stops moving** → target positions arrive faster than the client's advance budget can consume them, so the queue never drains
- **Jitter** → client speed overshoots or repeatedly catches/halts against the server's moving target stream
- **Trail never retracts** → the trail only enters fade/retract behavior when there are no pending movement targets; if the queue never fully drains, the trail remains in a pseudo-moving state forever

### Core conclusion

`VehiclePosition.speed` is valid as a **display/analytics field**.

It is **not a valid live animation clock** for consuming server-interpolated broadcast targets.

---

## Relevant code paths

## 1. Startup/backlog path (works well)

### Server
- `packages/server/src/index.ts`
  - keeps a `tickBacklog` of recent broadcast `WorldState`s
- `packages/client/src/ws.ts`
  - receives `msg.type === "init"`
  - dispatches `vehicle-backlog`
  - then `applyTick(backlog[backlog.length - 1])`

### Client
- `packages/client/src/map.ts`
  - `vehicle-backlog` → `feedBacklog(e.detail.backlog)`
- `packages/client/src/layers.ts` → `feedBacklog()`
  - builds a queue of shape distances from all backlog ticks
  - initializes animation state from that queue
  - notably uses a constant bootstrap animation speed (`ANIM_SPEED_MS`)

### Important property

The backlog path is effectively:

> a queue of already-authoritative target positions consumed by a simple client-side animator

It does **not** depend on per-vehicle GTFS timestamps for its motion budget.

That is consistent with the observed smooth startup behavior.

---

## 2. Live tick path (buggy)

### Server broadcast semantics

In `packages/server/src/interpolation/index.ts`:

- `interpolate()` builds live positions by interpolating between snapshot A and snapshot B
- interpolation uses:
  - snapshot/header timestamps
  - server playback time (`now - PLAYBACK_DELAY_S`)
- each broadcast contains a fresh `shapeDistTraveled` for the current canonical server tick

So the client is **already receiving a stream of interpolated positions**.

### Live speed semantics

The same server function also attaches `speed` using `avgSpeedOverHistory()`.

That speed is derived from:

- vehicle `shapeDistTraveled` over recent snapshots
- **vehicle timestamps** (`v.timestamp`)
- not the same clock as the 1s live broadcast stream

### Client consumption

In `packages/client/src/layers.ts` → `feedTick()`:

- live ticks update the target queue using broadcast `shapeDistTraveled`
- but `existing.speed` is also updated from `v.speed`

In `computeFrame()`:

- `anim.speed` determines how much distance budget can be consumed each frame
- pending targets determine whether the vehicle is still considered moving
- the trail only retracts when there are no remaining movement targets

### Important property

The live path is effectively:

> follow a server-authored stream of target positions using a client-authored motion budget from a different clock

That is the likely design error.

---

## Why the clocks are incompatible

## Clock A — server world/broadcast clock

Used for live interpolation target positions:

- based on server time and snapshot header timestamps
- shared by all clients
- canonical for `WorldState`
- broadcast every ~1s

## Clock B — per-vehicle observation clock

Used for `VehiclePosition.speed`:

- based on GTFS per-entity timestamps
- varies wildly per vehicle
- documented in `.memory/gtfs-vic.md` as ranging from ~10s to ~15m old within one snapshot
- not synchronized with the canonical broadcast step used for interpolation

## Consequence

Even if `speed` is numerically reasonable in a transport sense, it is not necessarily the right speed for consuming the stream of live broadcast targets.

A few concrete failure modes:

### 1. Client speed too slow for incoming target stream

If the client advance budget is smaller than the distance implied by successive live targets:

- `targets.length` grows or never fully drains
- arrow appears late or frozen
- trail never retracts because the vehicle never reaches the true idle state

### 2. Client speed too fast for incoming target stream

If the client advance budget is larger than the target spacing:

- arrow repeatedly snaps to small targets
- can look jittery or stop-go
- direction changes or tiny queue churn become visible

### 3. Stop behavior stays “moving” too long

If stale queued targets remain after the vehicle has effectively stopped:

- `targets.length > 0`
- trail logic stays in follow mode instead of retract mode
- snail trail appears broken / refuses to eat itself

---

## Why the backlog path hides the bug

`feedBacklog()` behaves differently from live `feedTick()`:

- it builds a finite queue from already-received positions
- it does not rely on live `v.speed` semantics for the same movement phase
- the queue is consumed as a simple bootstrap animation

So startup looks good even though the steady-state live path is using a different contract.

In other words:

> startup/backlog and live mode are not actually using the same animation semantics, even though they look superficially similar.

---

## Secondary observations

These are not the primary hypothesis, but they are worth noting.

### 1. `store.subscribe()` feeds animation on every store change

In `packages/client/src/map.ts`:

- `store.subscribe(() => { feedTick(vehicles); currentVehicles = vehicles; })`

This means `feedTick()` runs on **every store update**, not only on new `WorldState.seq` / new live data.

That can reprocess the same vehicle set when unrelated state changes occur, such as:

- selection changes
- route shape fetch completion
- filter changes
- stale/client-state transitions

This is probably not the main cause of the long-running live drift, but it increases the chance of duplicate target processing and makes the live reducer harder to reason about.

### 2. Animation speed and display speed are currently conflated

The current model uses `speed` both as:

- a UI/display concept (“how fast is this vehicle moving?”)
- an animation control concept (“how fast should I consume target positions?”)

Those are not necessarily the same thing.

For live mode in particular, they should probably be separate.

### 3. The architecture intent already points to a server-authoritative world clock

Per `.memory/tech-stack.md` and `.memory/animation-architecture.md`:

- the server emits the canonical world state
- clients should render from that shared state
- multi-window consistency depends on that shared clock

Using per-vehicle observation speed to drive live animation weakens that model.

---

## State-model formulation

## Current effective live state

For each vehicle, the relevant state is approximately:

- `currentDist`
- `targets[]`
- `tailDist`
- `anim.speed`
- `direction`

### Derived states

- `MOVING` → `targets.length > 0`
- `FADING` → `targets.length === 0 && tailDist !== currentDist`
- `STOPPED` → `targets.length === 0 && tailDist === currentDist`

## Intended invariant

When the server stops producing new movement for a vehicle, the client should eventually reach:

- `targets.length === 0`
- then `tailDist → currentDist`
- then `STOPPED`

## Suspected violated invariant in live mode

The client can remain in a non-terminal pseudo-moving state:

- targets continue to exist or reappear due to mismatched speed budget
- `currentDist` does not settle exactly like the backlog/bootstrap path
- trail never reaches retract-only behavior

---

## Most likely root cause

### Root cause statement

The client is treating live `WorldState` updates as if they were:

> raw observations that still need to be animated using `VehiclePosition.speed`

But they are actually:

> already-interpolated authoritative positions on the server's canonical clock

That mismatch is the main reason live mode diverges from the smooth backlog behavior.

---

## Proposed plan (no code yet)

## Goal

Make live mode obey the same contract as the smooth startup/backlog path:

> a sequence of authoritative target positions consumed on a canonical world clock

## Plan

### 1. Separate animation control from semantic vehicle speed

Treat `VehiclePosition.speed` as:

- display data
- analytics data
- heatmap input

Do **not** use it as the live motion budget for consuming server-authored target positions.

### 2. Define one animation contract for live ticks and backlog ticks

Represent both as the same client primitive:

- queue of target distances
- each target associated with an expected arrival interval on the world clock

That means live mode should animate according to:

- broadcast cadence / `WorldState.timestamp` / `seq`
- or explicit target-to-target duration

Not per-vehicle GTFS timestamp deltas.

### 3. Make live queue consumption world-clock-based **and constant-velocity**

The requirement is not just “reach the next target eventually”. Live mode must preserve **constant velocity** between updates.

So instead of using `VehiclePosition.speed` as the live motion budget, the client should derive a live animation segment from:

- previous authoritative target distance
- next authoritative target distance
- expected duration between those two world-state targets

That yields a constant segment velocity:

- fixed distance delta
- fixed duration on the canonical live/world clock
- linear progress within that segment

This preserves the desired look:

- constant-velocity motion in live mode
- same feel as the good startup/bootstrap path
- no snapping
- no variable-speed catch-up based on irregular GTFS timestamps

The important distinction is:

- **Keep constant velocity** as an animation property
- but derive it from **successive authoritative live targets on the world clock**
- not from the per-vehicle GTFS-derived `speed` field

### 4. Keep a separate display speed channel

UI labels and panels can still show:

- server-computed average speed
- client-derived playback speed when needed

But animation should not depend on that field in live mode.

### 5. Tighten feed ingestion boundaries

Only call `feedTick()` when a new `WorldState` arrives (new `seq`), not for unrelated store mutations.

This is a secondary cleanup step, but it will make the animation reducer deterministic and easier to validate.

### 6. Add temporary instrumentation before changing behavior

Before implementing the fix, log or expose debug counters for a few selected vehicles:

- queue length over time
- `currentDist`
- newest target dist
- distance lag (`target - currentDist`)
- display `v.speed`
- actual target delta per second from successive live ticks
- whether trail is in `MOVING` / `FADING` / `STOPPED`

Expected confirmation of this hypothesis:

- buggy vehicles will show persistent queue lag or repeated micro-target churn
- their `anim.speed` will not match the incoming live target slope
- trail failures will correlate with `targets.length` never reaching zero

---

## Minimal validation checklist for the eventual fix

When the fix is implemented, verify:

- [ ] startup backlog still animates smoothly
- [ ] live mode behaves the same as backlog/bootstrap
- [ ] live mode maintains constant velocity between successive live targets
- [ ] a stopped vehicle eventually reaches `STOPPED`
- [ ] trail retracts completely after stop
- [ ] no visible jitter on vehicles with irregular GTFS timestamps
- [ ] two tabs stay visually in sync
- [ ] playback still works through the same animation pipeline

---

## Short version

The live client is probably wrong because it uses:

- **server-interpolated positions** as targets
- but **per-vehicle GTFS-derived speed** as the consumption clock

Those are different clocks.

The startup backlog looks good because it behaves like a plain target queue.

The fix should make live mode use the same queue/world-clock semantics as backlog mode, while keeping **constant velocity per live segment** and treating `speed` as display/analytics data only.
