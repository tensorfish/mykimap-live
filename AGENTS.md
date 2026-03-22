# AGENTS.md

Instructions for AI agents working on this codebase.

## Read first

Before making any change, read these files in order:

1. `.memory/overview.md` — what the project is and who it's for
2. `.memory/tech-stack.md` — architecture, dependencies, and design constraints
3. `.memory/state-transitions.md` — server and client state machines, valid transitions, timing constants
4. `.memory/gtfs-vic.md` — GTFS feed structure, field availability, rate limits, polling strategy, route colors, shape data

These are the source of truth. The code implements what these documents describe.

## Behaviour

- **Read before writing.** Always read the relevant `.memory/` file before modifying the module it describes.
- **Verify after changing.** Run `bun run build` after every change. All three targets (server, client, docs) must pass.
- **Don't guess at feed behaviour.** The GTFS feeds have specific quirks (no speed, no tram bearing, always `IN_TRANSIT_TO`, absolute times not delay offsets). These are documented in `.memory/gtfs-vic.md`. Refer to it.
- **Follow the state machines.** Server and client state transitions are strictly defined. Don't add transitions without updating `.memory/state-transitions.md` first.
- **No frameworks on the client.** The client uses vanilla TypeScript, TanStack Store, deck.gl pure JS API, and Mapbox GL JS. No React, no Vue, no Svelte.
- **Bun everywhere.** Runtime, package manager, test runner, build tool. Don't introduce Node-specific APIs or npm/yarn/pnpm.

## What you must maintain

### `.memory/` — Design documents

These are living documents that describe the system as it is, not as it was.

| File | Describes | Update when... |
|---|---|---|
| `overview.md` | What the product is, who it's for, scale, data sources | Scope changes, new modes added, new data sources |
| `tech-stack.md` | Architecture, dependencies, data flow, design constraints | Any dependency added/removed, any architectural change |
| `state-transitions.md` | State machines, valid transitions, timing constants, log format | Any state added/removed, any transition changed, any timing constant changed |
| `gtfs-vic.md` | Feed structure, field availability, endpoints, auth, rate limits, shapes, colors | Any feed-related discovery or change |

### `docs/` — VitePress documentation

| File | Describes | Update when... |
|---|---|---|
| `architecture.md` | High-level system diagram, server/client responsibilities | Any architectural change |
| `data-flow.md` | Poll cycle, broadcast cycle, state machine diagrams, timing constants | Any data flow change |
| `setup.md` | Install, configure, run instructions | Any new env var, dependency, or setup step |
| `changelog.md` | What changed and when | Every user-visible change |

### `README.md` — Public-facing

Update when the quickstart steps change, new prerequisites are added, or the project structure changes.

## The update rule

**Every code change must be accompanied by updates to all affected documentation.**

Before finishing any task, check:

- [ ] `.memory/` files reflect the current state of the system
- [ ] `docs/` pages are consistent with `.memory/` and the code
- [ ] `README.md` quickstart still works
- [ ] `docs/changelog.md` has an entry if the change is user-visible
- [ ] `bun run build` passes (all three: server, client, docs)

If a change touches the server's polling logic, for example, you must update:
- `.memory/tech-stack.md` (data flow section)
- `.memory/gtfs-vic.md` (polling strategy section, if relevant)
- `docs/data-flow.md` (poll cycle diagram)
- `docs/changelog.md`

If a change adds a new environment variable:
- `.env.example`
- `.memory/tech-stack.md` or `config.ts` description
- `docs/setup.md`
- `README.md` (if it affects quickstart)

## Project layout

```
.memory/                  Design docs (source of truth)
  overview.md             Product description
  tech-stack.md           Architecture and dependencies
  state-transitions.md    State machines and timing
  gtfs-vic.md             Feed analysis and data structure

packages/server/          Bun backend
  src/
    index.ts              Entry point and boot sequence
    config.ts             All configuration and feed URLs
    types.ts              Shared type definitions
    state-machine.ts      Server FSM
    logger.ts             Structured transition logging
    poller/               Feed fetching and protobuf decoding
    interpolation/        Position interpolation (shape-following + fallback)
    shapes/               GTFS Schedule loader and route shape snapping
    broadcast/            WebSocket management

packages/client/          Vite frontend (vanilla TS, no framework)
  src/
    main.ts               Bootstrap
    store.ts              TanStack Store (single reactive state atom)
    state-machine.ts      Client FSM
    ws.ts                 WebSocket connection
    map.ts                Mapbox + deck.gl
    layers.ts             Vehicle rendering layer
    ui.ts                 Status bar DOM bindings

docs/                     VitePress documentation site
  .vitepress/config.ts    VitePress + Mermaid config
  index.md                Landing page
  architecture.md         System diagram
  data-flow.md            Poll/broadcast flows, state machines
  setup.md                Install and run guide
  changelog.md            Release history
```

## Key constants

| Constant | Value | Defined in |
|---|---|---|
| Poll interval | 7s | `config.ts` → `POLL_INTERVAL_MS` |
| Broadcast interval | 1s | `config.ts` → `BROADCAST_INTERVAL_MS` |
| Stale vehicle threshold | 120s | `config.ts` → `STALE_VEHICLE_THRESHOLD_MS` |
| Client stale threshold | 5s | `ws.ts` → `STALE_THRESHOLD_MS` |
| Reconnect max retries | 5 | `ws.ts` → `MAX_RETRIES` |
| Auth header | `KeyID` | `feeds.ts` |
| Feed base URL | `api.opendata.transport.vic.gov.au/...` | `config.ts` |

## Testing a change

```bash
# Build everything
bun run build

# Run server (needs OPENDATA_VIC_API_KEY in .env)
bun run dev:server

# Run client (needs VITE_MAPBOX_ACCESS_TOKEN in .env)
bun run dev:client

# Health check
curl http://localhost:3000/health
```

The `/health` endpoint returns current server state, vehicle count, alert count, connected client count, and last poll timestamp.
