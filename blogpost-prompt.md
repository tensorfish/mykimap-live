# Blog Post Prompt — MykiMap Live

## Your task

Write a blog post about **MykiMap Live** — a real-time map that shows every tram, train, and bus in Victoria, Australia, moving on a map in real time. ~2,000 vehicles, updated every second, with historical playback like a YouTube-style time machine.

The author built this as a vibe coding project. The thesis, demonstrated not stated: **everyone has access to the same AI tools now — taste is the differentiator.** The author wanted to get familiar with AI-assisted coding, picked a project they actually wanted to build, and every decision that separates the result from slop was a taste decision, not a technical one the AI couldn't handle. Write from first person.

---

## Distribution — READ THIS FIRST

This post needs to land on **Hacker News**, **r/programming**, **r/webdev**, **r/dataisbeautiful**, **r/melbourne**, and **Twitter/X dev circles**. Design every element for shareability. Each platform has different norms — the blog post is the same, but the title and framing shift per platform.

---

### Hacker News (highest priority)

HN is the hardest audience and the highest leverage. Get this right and the others follow.

**HN culture you must respect:**
- HN mods **rewrite clickbait titles.** If your title is too cute, they'll neuter it to something boring. Design a title that survives mod editing because it's already substantive.
- HN readers are the most technically sophisticated audience. They'll read the whole post. They'll check your architecture. They'll open your source code. Superficial content gets flagged and killed.
- HN hates: engagement bait, "here's what I learned", marketing-as-content, anything that smells like self-promotion without substance. They can smell it instantly.
- HN loves: deep technical content, novel approaches, craftsmanship, honest tradeoff discussions, thoughtful architecture, real data from real systems. "Show HN" posts with working demos that are genuinely impressive.
- **Paul Graham wrote "Taste for Makers."** The taste angle resonates deeply with HN's DNA. This audience already believes taste matters — you don't need to convince them, just show them a concrete example.
- The engineering details (shape snapping, DuckDB on both sides, architectural seams, vanilla TS with no framework) are HN catnip. Don't bury them.

**HN title candidates (short, factual, hook embedded in the facts):**

1. `Show HN: Real-time map of every bus, tram and train in Melbourne – vibe-coded with taste`
2. `Show HN: MykiMap – 2k vehicles at 60fps, vibe-coded, then made not-slop`
3. `Show HN: I vibe-coded a live transit map of Melbourne. The AI wrote the code, taste did the rest.`
4. `Show HN: MykiMap – Live map of every vehicle in Melbourne's transport network`
5. `Show HN: Real-time Melbourne transit – 2k vehicles, shape-snapped interpolation, DuckDB time machine`

**Why these work for HN:**
- `Show HN:` format — this is a project you built, not a blog you wrote. HN treats these differently (dedicated pool, more goodwill from readers).
- Short enough that mods won't rewrite. Factual enough to survive scrutiny.
- #1 and #3 include the taste hook without being clickbait — they describe what happened, not what you'll "learn."
- #4 is the safe fallback — purely factual, lets the content do the work. If the post is good enough (it should be), a factual title still hits front page.
- #5 is the technical-bait version — HN readers who see "shape-snapped interpolation" and "DuckDB time machine" will click out of genuine curiosity.

**HN-specific post structure notes:**
- The first 2 paragraphs must hook a HN reader. That means: what the thing IS (concrete), why it's interesting (specific), and a hint that the technical depth is coming. No throat-clearing.
- HN readers will skip to the engineering sections. Make sure the taste decisions section is dense with real details, not hand-wavy. Show the actual tradeoff: "GPS lerp cuts through buildings, here's what shape snapping looks like instead." They want to see the before/after.
- The "vibe coding" angle works on HN IF you're honest about it. HN hates hype. If you say "AI crushed the scaffolding" but then show where it produced garbage and you had to fix it, that's credible. If you just say "AI is amazing" they'll downvote and move on.
- Expect HN commenters to ask about: the interpolation algorithm, why DuckDB over SQLite, why no React, how the shape snapping handles edge cases, what the server's memory footprint is with 3.7M shape points in memory. The post should preemptively answer the interesting ones.
- The architectural seams section (designing `WorldState` as a single interchange format, `applyTick()` source-agnostic) will resonate hard with HN. This is the kind of forethought that senior engineers recognize and respect.

---

### Reddit + Twitter/X

**Reddit/Twitter title candidates (longer, more personality):**

1. `I vibe-coded a real-time map of every bus, tram and train in Melbourne. The AI wrote the code. Taste made it not slop.`
2. `I vibe-coded a real-time map of 2,000 vehicles at 60fps. The difference between slop and something you'd actually use was giving a shit.`
3. `Everyone has the same AI tools now. I vibe-coded a live transit map of Melbourne to see what taste gets you.`
4. `I vibe-coded a live map of Melbourne's entire transport network — 2,000 vehicles moving at 60fps with a time machine that replays whole days in 4 minutes`
5. `The Victorian government publishes real-time locations of every bus, tram and train. I vibe-coded a map that shows all 2,000 of them moving at once.`

**Why these work:**
- "Vibe-coded" is polarizing — haters click to dunk, believers click to validate, curious people click to learn. Guaranteed engagement from all camps.
- "Taste" / "giving a shit" as the differentiator is a TAKE. It's tweetable, quotable, screenshottable. People will argue about it. That's the point.
- It reframes the vibe coding debate: the question isn't "can AI code?" — it's "do you have taste?" That's provocative without being preachy.
- Concrete numbers (2,000 vehicles, 60fps, 4 minutes) make it feel real, not marketing.
- "Melbourne" / "Victorian government" grounds it — locals will share it because it's THEIR city.

### The four audiences (post must work for all simultaneously)

1. **HN / skeptical senior engineers** — they click for the architecture, stay for the tradeoffs, upvote for the craftsmanship. Feed them: shape snapping algorithm, DuckDB on both sides, architectural seams, "why not React." They'll respect the taste angle because they've lived it.
2. **The vibe coding crowd** (r/ChatGPT, AI Twitter) — "look what's possible now, this is the future." They want validation that AI-assisted coding produces real things, not just demos.
3. **Working engineers** (r/programming, r/webdev) — "okay but the actual engineering is legit, the AI didn't magically solve the hard problems." They want to see where the human judgment mattered.
4. **Normies / transit nerds** (r/melbourne, r/dataisbeautiful, general Twitter) — "holy shit look at this cool map of my city." They don't care about the stack. They care about the visuals and that it's Melbourne.

The post must satisfy ALL FOUR without alienating any. The trick: be honest. You wanted to learn the workflow. You picked a project you cared about. The AI could write all the code — the thing it couldn't supply was taste. Every decision that separates the result from slop (shape-following not GPS lerp, delayed playback not prediction, server-authoritative not client-guessing, route trails not straight lines) was a taste call. Don't oversell or undersell the AI's contribution — but make clear that the human contribution was knowing what "good" looks like and refusing to stop before getting there.

### Visual assets (mention in the post or reference where they'd go)

Reddit posts with visuals get 3-10x engagement. The post should reference or imply:
- A hero GIF/video of the map with vehicles moving (this is the money shot — trams gliding down Swanston St, trains fanning out from Flinders)
- A before/after of GPS lerp vs shape-snapped interpolation (cuts through buildings vs follows the road)
- A timelapse clip of the time machine (morning rush building, evening rush fading)
- The congestion heatmap lighting up during peak hour

**Note for the writer:** Don't embed actual images (we'll add those separately). Just write `[screenshot/gif: description]` where a visual would go, so we know where to place them.

---

## Writing style: match libevm.com

Study these characteristics and internalize them. This is the voice:

### Tone
- **Casual, conversational, engineer-talking-to-engineer.** Not a Medium thought-leadership piece. Not a corporate announcement. A dev who built something cool and is walking you through it.
- **Self-deprecating but not insecure.** Acknowledge jank, bad decisions, and limitations openly. "my frontend skills are terrible", "I know, the model currently sucks."
- **Genuinely enthusiastic about the nerdy details.** When something is cool, say it's cool. "I thought this was really cool so I thought I'd write an article about it."
- **Irreverent.** Misattribute quotes for laughs. Drop in memes and pop culture refs casually. Swear occasionally but not gratuitously.
- **Direct.** Short paragraphs. Punch lines land in their own sentence. No filler words. No "In this blog post, we will explore..."
- **Honest about the AI.** Don't be cringe about it. Don't say "my AI pair programmer" or "collaborating with Claude." Be matter-of-fact: I prompted, it generated, I fixed the stuff it got wrong. The AI could write any code I described — the bottleneck was always knowing what to ask for. That's taste.

### Structure
- **Start with the itch.** The vibe coding angle IS the itch. Not "I wanted to build a transit map." It's "vibe coding was everywhere, I wanted to get familiar with the workflow, and I had something I actually wanted to build." The motivation is genuine curiosity about the tool + a project they cared about, NOT a deliberate stress test or an attempt to prove a point.
- **Show the journey, not just the result.** What did the AI handle easily? Where did it fall over? What required actual engineering judgment?
- **Code comes after context.** Explain the WHY in plain words, then show the HOW with code/architecture.
- **End abruptly.** Don't write a formal conclusion. "And thats it!" or "Ciao." or just… stop after the last interesting thing.
- **Links section at the bottom.** Clean, no inline "click here" links in the prose.

### Formatting
- Use headers to break sections but don't over-structure. This is a blog post not a whitepaper.
- Tables and code blocks are fine when they add clarity.
- Short bullet lists for enumeration, but don't bullet-point the entire post.
- Emoji sparingly — one or two max, for emphasis (😎, not 🚀🔥💪🎉).

### What NOT to do
- Don't use LinkedIn-brain language: "leverage", "utilize", "deep dive", "game-changer", "robust", "seamless"
- Don't explain what a WebSocket is or what real-time means. Assume the reader is technical.
- Don't write an intro paragraph that summarizes the post. Just start.
- Don't end with "Feel free to reach out!" or "I hope this helps!"
- Don't use the word "journey" unironically
- **Don't be preachy about AI.** No "AI won't replace programmers, but programmers who use AI will replace those who don't." No hot takes about the future of software engineering. Just show what happened on this specific project.
- **Don't be a shill.** Don't name-drop the specific AI model repeatedly. It's a tool. You used it. Move on.
- **Don't explicitly state the thesis.** Never write "taste is the differentiator" or "the lesson is that giving a shit matters." The reader should feel it from every example. If you have to state it, you've failed to show it. The ONE exception: the last line of the post can land it, once, casually, like a throwaway — not like a TED talk punchline.
- **Don't frame taste as "human vs AI."** It's not adversarial. The AI is great. You like using it. Taste isn't about what the AI can't do — it's about what you choose to ask for. The AI will happily write shape-snapping interpolation. It just won't tell you that you need it.

---

## The project — what you're writing about

### What it is
A top-down live map of Melbourne/Victoria's entire public transport network. Every active tram, train, and bus appears as a colored directional arrow, moving along its actual route in real time, with a fading trail behind it. Open it in two browser tabs — every vehicle is in the same spot on both.

### The numbers
- ~2,000 vehicles at any time (~160 trams, ~90 trains, ~1,700 buses, ~30 V/Line regional trains)
- 10 GTFS Realtime feeds polled every 15 seconds (~558 KB per cycle)
- Server interpolates positions along actual route geometry and broadcasts to all clients every 1 second
- Client renders at 60fps using deck.gl (GPU-accelerated) on top of Mapbox
- Historical playback: DuckDB records every poll, exports to Parquet. Client streams 30-minute chunks via DuckDB-WASM. YouTube-style buffer bar, seek, speed control (1×, 10×, 60×, 360×). An entire day of Melbourne transport compressed into 4 minutes.

### The stack
- **Bun** everywhere — server, client tooling, package management
- **Server**: Bun.serve (HTTP + WebSocket), protobufjs for GTFS-RT decoding, DuckDB for recording, custom shape-snapping interpolation engine
- **Client**: Vanilla TypeScript (no React, no framework), TanStack Store, deck.gl pure JS API, Mapbox GL JS, DuckDB-WASM for playback
- **Docs**: VitePress

### The interesting engineering bits (weave these into the narrative)

1. **The feeds are jank.** No speed on any feed. No bearing on trams. `current_status` is always `IN_TRANSIT_TO` even when parked. Per-vehicle freshness ranges from 10 seconds to 15 minutes old within a single snapshot. The feeds cache server-side for ~30 seconds so every other poll returns stale data. You have to derive everything. This is the kind of thing AI doesn't know about until you tell it — the spec says one thing, the real data says another.

2. **Shape-following interpolation, not GPS lerp.** Straight-line interpolation between GPS points cuts through buildings. The server downloads a 191 MB GTFS Schedule ZIP, extracts 3.7 million shape points, builds an in-memory trip→shape index, and snaps every vehicle onto its actual route polyline. Interpolation happens along the curves of the road, not as the crow flies. 30-second delayed playback between two known positions — no prediction, no overshoot.

3. **Multi-client consistency.** The server is authoritative. It stamps every broadcast with a canonical timestamp. Every connected browser receives the same interpolated positions at the same tick. Two tabs, same tram, same spot. No client-side guessing.

4. **The time machine.** DuckDB on the server records every fresh poll into daily `.duckdb` files (Melbourne timezone — matches PTV service days). The client doesn't download the whole day. It fetches a ~1 KB metadata response (slider renders instantly), then streams 30-minute Parquet chunks on demand (~4–13 MB each) via DuckDB-WASM. Buffer bar shows loaded ranges. Prefetch next chunk while playing. LRU eviction caps memory at ~50 MB. It's literally YouTube but for transport data.

5. **One render loop for everything.** Live mode and playback share exactly the same animation pipeline: `applyTick(WorldState) → feedTick → computeFrame(60fps) → render`. Speed multiplier: live=1, playing=speed, paused=0. No duplicate animation code.

6. **Congestion heatmap.** Server seeds, client accumulates. 200m route segments, 10-minute sliding window, speed normalized against mode baselines (30 km/h for trams, 80 km/h for trains). Red = stopped, green = normal. The alpha scales with sample count — more readings = more confidence = more opaque.

7. **Architectural seams for the time machine.** `PollResult` is pure serializable (no side effects). `WorldState` is the single interchange format. `applyTick()` doesn't care if data is live or historical. The rendering pipeline has no dependency on WebSocket liveness. These constraints were designed upfront so the time machine was an addition, not a rewrite.

8. **On-load animation.** Server sends a 15-tick backlog on WebSocket connect. Client processes all ticks, places arrows at the oldest position, then glides them to current over 3 seconds. Visible movement from frame 1. No blank screen → sudden pop-in.

### Data source
Victorian government's open transport data portal. 4 vehicle position feeds, 4 trip update feeds, 2 service alert feeds. Auth is a single API key in a `KeyID` header. Free to register.

### The name
"Myki" is Melbourne's transit card (like Oyster, Suica, Opal). Everyone who catches public transport in Melbourne knows what a Myki is.

---

## The REAL narrative arc (this is crucial)

### The thesis (SHOW, don't say)

**Everyone has the same AI tools. The differentiator is taste.**

DO NOT state this as a thesis. Do not write "I believe taste is the differentiator." Instead, demonstrate it through the entire post. Every engineering decision you walk through should implicitly make this point: the AI could write any code you asked for — it was fast, it was capable — but it would happily produce slop if you let it. The thing that made this project good was knowing what "good" looks like and not stopping until you got there. That's taste. That's giving a shit. Let the reader arrive at this conclusion themselves.

The word "taste" should appear maybe once or twice, casually, like it's obvious. Not bolded. Not as a section header. Just dropped in like it's the most natural thing in the world.

### The motivation (keep it low-key)

Don't frame this as a grand experiment or a thesis about AI capabilities. The motivation is simple and honest: vibe coding was the meta, I wanted to get familiar with it, I had a project I'd been wanting to build. That's it. The taste angle emerges naturally from the decisions you made along the way, not from some upfront declaration.

### 1. The vibe coding itch
Vibe coding was the meta. Everyone was doing it. Twitter timeline was wall-to-wall "I built X in one afternoon with AI." I'd been meaning to try it properly — not just asking it to fix a bug, but actually building something start to finish in this new workflow. I had a project I'd been wanting to build for a while: a live map of every vehicle in Melbourne's transport network. Seemed like a good excuse to get familiar with the tools while making something I'd actually use.

### 2. The fast part
The AI absolutely crushed the scaffolding. WebSocket server, protobuf decoding, basic map rendering, store setup, CSS, build config — the boring-but-necessary 70% of any project. This stuff used to take days of boilerplate. Now it takes minutes. This is where the vibe coding hype is real. I was moving fast and things were appearing on screen.

### 3. The "this looks like slop" moment
Then I looked at what I actually had. GPS dots jumping every 30 seconds. Straight-line interpolation cutting through buildings. Trams spinning because the feed has no bearing data. Vehicles frozen for 15 minutes because the feed says they're "in transit" when they're parked at a depot. It worked. It was also clearly slop. The kind of thing you see in every "I built this in a weekend" post where the demo video is carefully cropped and you never see it again. I didn't want that. I actually wanted to use this thing.

This is the inflection point of the whole post. The AI gave me working code. But working isn't good. Anyone can ship working. The question was whether I was going to stop here or keep going.

### 4. Taste decisions (the heart of the post)

Frame EACH of the following as a taste call — not a technical challenge the AI couldn't handle, but a decision to care about something most people would ship without:

- **"Trams should follow the road, not cut through buildings."** → Shape-following interpolation. 191 MB GTFS dump. 3.7M shape points. Snap every vehicle onto its actual route polyline. The AI wrote the snapping algorithm once I described it. But the decision to do it at all — to reject the GPS lerp that technically works — that's taste.

- **"If I open two tabs, the trams should be in the same spot."** → Server-authoritative clock. Every client gets the same interpolated position at the same tick. The AI set up the WebSocket broadcast. But the decision that consistency matters, that you shouldn't see two different versions of reality — that's giving a shit about something nobody asked for.

- **"The trail behind each vehicle should follow the actual route shape, not be a straight line."** → 800m slice of the route polyline behind the arrow. Trail tail follows the arrow; eats itself when the arrow stops. Could've been a simple fading line. Chose to make it trace the road.

- **"Vehicles that haven't updated in 2 minutes shouldn't drift across the map."** → Stale vehicle detection. The feed says every vehicle is "in transit to" even when it's parked at Camberwell depot at 1am. The AI doesn't know that. You know that because you looked at the data at 1am.

- **"I should be able to rewind and watch the morning rush build."** → The time machine. DuckDB on both sides. YouTube-style chunk streaming. This is the biggest taste call: the live map is interesting for 30 seconds. The timelapse is what you come back to. Nobody needs this. But it's the thing that makes you go "holy shit."

- **"When you first open the page, vehicles should already be moving."** → 15-tick backlog on connect. Arrows glide from past positions to current over 3 seconds. No blank screen → pop. This is a 50-line detail that 99% of people would skip. It's the difference between "oh cool, dots" and "whoa, it's alive."

Each of these is something the AI could implement once asked. The AI never pushed back and said "actually, GPS lerp is fine." It doesn't have taste. It doesn't know what good feels like. It just does what you tell it. **The quality of the output is bounded by the taste of the person driving it.** (Again — SHOW this through the examples, don't STATE it as a thesis.)

### 5. The time machine (expanded)
The live map is cool for 30 seconds. The time machine is what makes people come back. Whole-day timelapse. Morning rush building. Last trams fading out at 1am. An entire city's transport network compressed into 4 minutes. YouTube-style streaming so you don't download the whole day. This is the part where normies share it and engineers ask "wait, how?"

Also a good place to mention the architectural seams — `WorldState` as the single interchange format, `applyTick()` agnostic to data source, rendering pipeline independent of WebSocket liveness. These were designed upfront. That's another taste call: designing for the feature you're going to want, not just the one you're building now.

### 6. Landing it
Short. It works. ~2,000 vehicles. 60fps. Smooth. Consistent across clients. Historical playback. Congestion heatmap. I learned the vibe coding workflow. The tools are genuinely good. But the tools are the same for everyone now. The thing that separates this from slop is the same thing that's always separated good software from bad: giving a shit.

### 7. End abruptly
No grand conclusion. No manifesto. Don't moralize. Maybe something throwaway and funny. Then stop.

---

## Platform-specific posting notes

### Hacker News
- Submit as `Show HN:` linking directly to the live demo URL, with the blog post URL in the first comment ("Blog post with the technical writeup: [link]"). Show HN posts that link to a working demo outperform blog-post-only submissions. If no live demo URL, link the blog post directly.
- First comment should be a tight 3-4 sentence summary: what it is, what the interesting technical bits are, and a link to the source code if public. HN readers check the comments before clicking the link.
- Don't self-promote in the title. `Show HN:` format already implies you built it.
- If the title gets rewritten by mods to something boring, don't panic — the content carries it if it's good enough.
- **Timing:** Post between 8-10am US Eastern (Mon-Thu). HN front page is most active then.
- Expect the top comments to be about the architecture, not the vibe coding angle. That's fine — the taste point lands subconsciously through the engineering detail.

### Reddit
- Use the longer Reddit-style title (from the Reddit title candidates above).
- Add `[OC]` tag for r/dataisbeautiful.
- Crosspost to: r/programming, r/webdev, r/dataisbeautiful, r/melbourne, r/australia, r/transit, r/urbanplanning, r/ChatGPT.
- For r/melbourne and r/dataisbeautiful: lead with the hero GIF/video, not the blog link. Image/video posts get 5-10x the engagement of link posts on these subs.
- For r/programming: link post to the blog is fine. The technical content carries it.

### Twitter/X
- The blog post should be written so the first 2-3 paragraphs work as a standalone Twitter thread hook when excerpted. Front-load the most visually compelling and surprising details.
- The hero GIF/video is **mandatory** for Twitter — text-only posts about coding projects get 10% of the engagement.
- Tweet the GIF with a 2-3 sentence hook, then thread the blog post link. Don't thread the whole blog — link out.

### Why the taste angle works across all platforms
- **HN:** Paul Graham wrote "Taste for Makers." This audience already believes taste matters. You're giving them a concrete example to point to. They'll upvote it as validation of something they already think.
- **Reddit:** "Taste is the differentiator" is a TAKE — people will argue about it. Both "AI will replace devs" and "AI is overhyped" camps have to engage with it. It validates BOTH sides: yes the AI is powerful, AND yes you still need to be good.
- **Twitter:** It's tweetable, quotable, screenshottable. "Everyone has the same AI tools now. The differentiator is taste." That's a screenshot tweet.
- **All platforms:** The list of taste decisions is designed to make devs nod and think "yeah, I would've shipped the GPS lerp." That's the moment they share it.

---

## The blog post title (the `<h1>`)

The blog post's own title is different from the platform submission titles. It lives on your site and should be:
- Short, punchy, works without platform context
- Doesn't start with "I" (that's for Reddit/Twitter submission titles)
- Should work when someone shares the URL and the title shows in the preview card

**Candidates:**
1. `Vibe Coding with Taste` — short, PG-essay energy, makes you click
2. `Vibe Coding a Live Transit Map of Melbourne` — descriptive, clean
3. `2,000 Vehicles at 60fps` — ultra-short, curiosity gap
4. `The AI Wrote the Code. Taste Made It Not Slop.` — the take, as a title

Pick the one that feels right for the libevm.com voice. #1 or #4 are strongest.

---

## Length

~1,500–2,500 words. Technical enough to be interesting to engineers. Casual enough that someone who rides the 96 tram every morning would enjoy the first half and share it.

## Output format

Markdown. Use `#` for the title, `##` for sections. Code blocks with language tags. No front matter needed. Include `[screenshot/gif: description]` placeholders where visuals should go.
