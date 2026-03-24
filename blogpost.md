# Vibe Coding with Taste

Vibe coding was everywhere. My timeline was wall-to-wall "I built X in one afternoon with AI." SaaS clones, landing pages, todo apps with slightly nicer CSS. Some of it genuinely impressive. Most of it the kind of thing you look at for 10 seconds and never open again.

I'd been meaning to actually try it — not just asking the AI to fix a bug or write a test, but building something from scratch in this workflow everyone was losing their minds over. I also had a project I'd been wanting to build for a while: a live map of every vehicle in Melbourne's public transport network. Not one bus route. All of them. Every tram, every train, every bus, all moving at once.

Seemed like the perfect excuse. Learn the tools, make something I'd actually use.

[screenshot/gif: hero shot — the full map at night, ~2,000 arrows moving across Melbourne, tram trails glowing along Swanston St, trains fanning out from Flinders Street]

## What it is

The Victorian government publishes real-time GPS positions for every active public transport vehicle in the state. ~2,000 vehicles across 10 feeds. Trams, metro trains, buses, regional V/Line. The data is free — you register, get an API key, and you're pulling protobuf streams of lat/lon coordinates updating every 30 seconds.

MykiMap takes all of that and puts it on a map. Every vehicle is a colored arrow pointing in its direction of travel, with a fading trail behind it that traces the actual route. Open it in two browser tabs — every tram is in the same spot on both.

There's also a time machine. You can rewind to any recorded day and watch the entire network in timelapse. Morning rush building from nothing. Last trams fading out after 1am. A whole day of Melbourne's transport compressed into 4 minutes.

## The fast part

The AI crushed the scaffolding. I'm not going to pretend otherwise.

WebSocket server, protobuf decoding, basic Mapbox setup, store wiring, CSS, build config, the initial deck.gl layer — all of it appeared in minutes. The stuff that normally takes a day or two of boring-but-necessary boilerplate was just... done. I described the architecture I wanted (Bun server, vanilla TypeScript client, TanStack Store, deck.gl for rendering) and it wired the whole thing up.

Within a couple of hours I had dots on a map.

## The slop

Then I actually looked at what I had.

GPS dots jumping every 30 seconds. Straight-line interpolation between positions — which means the 96 tram was cutting through the NGV and a couple of apartment buildings on its way down St Kilda Road. Trams spinning in place because the feed provides zero bearing data for trams (trains and buses have it, trams just don't — thanks Yarra Trams). Vehicles frozen in the middle of intersections for 15 minutes because the feed says every single vehicle is `IN_TRANSIT_TO` its next stop, always, even when it's parked at Camberwell depot at 1am.

It worked. It was also the kind of thing you see in every "I built this in a weekend" post where the demo GIF is carefully cropped to hide the jank.

[screenshot/gif: before — GPS dots lerping through buildings, trams pointing random directions, the ugly version]

I didn't want that. I actually wanted to use this thing.

## The feeds are a mess, by the way

Quick aside on the data, because it's entertaining.

The GTFS Realtime spec says vehicles should report speed. None of the four Victorian feeds do. Speed is always zero. You have to derive it from consecutive position deltas yourself.

The spec says vehicles should report `current_status` — whether they're stopped at a station, in transit, incoming. Victoria's feeds report every vehicle as `IN_TRANSIT_TO`, always, regardless of what it's actually doing. A tram sitting at the Essendon depot since midnight? In transit to.

Per-vehicle timestamps within a single snapshot range from 10 seconds old to 15 minutes old. Some vehicles are basically real-time. Some haven't phoned home since the driver went on break. And the feed itself caches server-side for ~30 seconds, so every other poll returns identical data.

The AI had no idea about any of this. It generated beautiful interpolation code that assumed the feeds would provide speed and bearing and fresh coordinates on a regular cadence. The spec says they should. The data says otherwise.

## Making it not slop

This is where it got fun.

**Trams should follow the road.** The government publishes a 191 MB GTFS Schedule ZIP alongside the realtime feeds. Inside it: 3.7 million shape points defining the geometry of every route in the state. I download that on server boot, build an in-memory trip→shape polyline index, and snap every vehicle onto its actual route.

Now interpolation doesn't happen as the crow flies. It follows the curves of the road. The 96 tram glides down St Kilda Road instead of phasing through buildings. The Belgrave line hugs the curves through the Dandenongs. That's like 191 MB of static data just to make vehicles not look stupid, but the difference is night and day.

[screenshot/gif: before/after — GPS lerp cutting through buildings vs shape-snapped interpolation following the road]

**The server runs 30 seconds behind.** Instead of trying to predict where vehicles will be (which is how you get overshoot and rubber-banding), the server interpolates between two *known* positions. Poll A says the tram is here. Poll B says it's there. For the next 30 seconds, interpolate along the shape between those two points. No guessing. No prediction. The trams are always somewhere they actually were.

**If I open two tabs, the trams should be in the same spot.** The server stamps every broadcast with a canonical timestamp. Every connected client gets the same interpolated positions at the same tick. No client-side guessing, no "well it's roughly here." Two tabs, same tram, same spot on the road. This was maybe an afternoon of work but it's one of those things that makes the whole system feel *solid* instead of approximate.

**Trails should trace the route, not be straight lines.** Each vehicle's trail is an 800m slice of the actual route polyline behind the arrow. The tail follows the arrow at the same speed — when the arrow stops, the tail catches up and "eats itself." Could've been a simple fading line. Looks 10x better as the actual road geometry.

**Parked vehicles shouldn't drift.** If a vehicle's timestamp is more than 2 minutes old, it's probably sitting at a depot. Don't interpolate it. Don't make it drift across the map toward a ghost position. Just hold it where it is. I only figured this out because I was looking at the data at 1am and noticed half of Melbourne's tram fleet slowly sliding toward random intersections.

**The page should feel alive immediately.** When you connect, the server sends a backlog of 15 ticks. The client places every arrow at its oldest backlog position and glides it to current over 3 seconds. First frame: vehicles are already moving. No blank screen, no loading spinner, no pop-in. This is like 50 lines of code. Most people would skip it. But it's the difference between "oh cool, dots" and "whoa."

[screenshot/gif: the on-load animation — arrows appearing and gliding into position across the map]

None of these were hard to implement. The AI wrote most of the code once I described what I wanted. But the AI never once said "hey, GPS lerp cuts through buildings, you should probably fix that." It doesn't know what looks good. It doesn't know what feels right. It just does what you ask. The whole difference was knowing what to ask for.

## The time machine

Once the core was working and not embarrassing, I asked it:

> "whats the single smartest and most radically innovative and accretive and useful and compelling addition you could make to the project at this point?"

It came back with a time machine. Historical playback. Record every poll, let users rewind and watch the network in timelapse. Genuinely a great suggestion — I wouldn't have prioritized it that early on my own, but it was obviously the right call the moment I read it.

(Side note on the workflow: before I type anything into the coding agent, I have another terminal open where I dump what I want to do in plain English and ask a separate model to optimize it into a proper prompt. Then I trim it, add context, remove the stuff it over-engineered, and paste that into the CLI. Clay molding clay. But it works — the quality of what comes out of the coding agent is directly proportional to the quality of what you feed it.)

The live map is cool for about 30 seconds. Then you've seen it. The time machine is the real shit.

Pick a date, hit play at 360× speed, and watch the entire city wake up. First trains appearing at 4am. The tram network lighting up at 5. Morning rush building into a swarm by 8. Midday lull. Afternoon surge. Last services trickling out past midnight. A whole day in 4 minutes.

[screenshot/gif: time machine timelapse — morning rush building, full density at 8am, the network as a living breathing thing]

DuckDB on the server records every fresh poll. The client streams Parquet chunks on demand via DuckDB-WASM — works like YouTube buffering. Pick a date, seek anywhere, chunks load as you watch.

## The heatmap

There's also a congestion layer. The server tracks vehicle speed across 200-meter route segments in a 10-minute sliding window and seeds it to new clients. The client keeps accumulating locally from there. Speed gets normalized against baselines per mode — 30 km/h for trams, 80 km/h for trains, 40 km/h for buses.

Red means stopped. Yellow means slow. Green means normal. Alpha scales with sample count so you're not drawing bright red segments from a single data point.

Turn it on during morning peak and you can watch the Hoddle Street bottleneck light up like Christmas.

[screenshot/gif: congestion heatmap during peak hour — red segments along known Melbourne bottlenecks]

## The stack

Kept it deliberately simple.

| Layer | Choice |
|---|---|
| Runtime | Bun (server, scripts, package management — everything) |
| Server | `Bun.serve` — HTTP, WebSocket, static files |
| Feed decoding | `protobufjs` — 10 GTFS-RT protobuf feeds per poll |
| Recording | DuckDB — daily `.duckdb` files, auto-export to Parquet |
| Client | Vanilla TypeScript. No React. No framework. |
| State | TanStack Store |
| Map | Mapbox GL JS |
| Rendering | deck.gl pure JS API — GPU-accelerated, handles 2k moving points at 60fps |
| Playback | DuckDB-WASM — decodes Parquet chunks in the browser |

No React because I didn't need React. The entire UI is a map with some overlays. TanStack Store for reactivity, deck.gl for rendering, direct DOM manipulation for the handful of UI elements. Adding a virtual DOM to diff a status bar and a filter chip row felt like bringing a forklift to move a chair.

## And thats it

~2,000 vehicles. 60fps. Shape-snapped. Server-authoritative. Time machine with YouTube-style streaming. Congestion heatmap. Vanilla TS. No framework.

I learned the vibe coding workflow, which is what I set out to do. The tools are fast. Genuinely fast. But they'll make exactly what you ask for, and nothing more. The same tools that built this will happily produce slop if you let them. Only difference is giving a shit.

---

## Links
- MykiMap Live (coming soon)
- Victoria open transport data portal — opendata.transport.vic.gov.au
- GTFS Realtime spec
- deck.gl
- DuckDB-WASM
