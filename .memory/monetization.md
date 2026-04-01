# Monetization Strategy

How to monetize mykimap-live while upholding the integrity of the project.

---

## Principle

**Do not monetize the live public map first. Monetize the archive, the tooling, and the commercial convenience around it.**

The core public experience should remain the free live map. The strongest differentiated assets already in the codebase are:

- **Historical playback** via DuckDB/Parquet
- **Shareable replay URLs**
- **Congestion heatmap**
- **Route shape export** and clean `WorldState` interchange
- **Recorded daily snapshots** with time-range export endpoints

That suggests the best business model is:

**free public viewer + paid power tools**

Not:

**paywall the map**

---

## Integrity Rules

If project integrity matters, these rules should be explicit:

1. **Keep the live map free.**
2. **Never sell exclusivity over raw public GTFS data.** Sell curation, reliability, archive, UX, and analysis.
3. **No intrusive ads** covering or degrading the map experience.
4. **Minimal tracking**; avoid surveillance-style analytics.
5. **Clear attribution** to Victorian public transport data.
6. **Clearly label derived metrics** like speed, congestion, and playback interpolation as estimates or derived values where relevant.

---

## Best Monetization Paths

Ranked by fit with the current architecture.

### 1. Paid historical archive and exports

This is the cleanest fit with the code that already exists.

The server already exposes or is structured around:

- `GET /data/snapshots`
- `GET /data/snapshots/:date/meta`
- `GET /data/snapshots/:date?from=&to=`
- Full-day Parquet export

That is already the skeleton of a paid product.

#### Free tier

- Live map
- Possibly **today + yesterday** replay
- Basic playback UI
- Basic filters

#### Paid tier

- **Longer retention**: 30 / 90 / 365 days
- **Bulk export**: CSV/Parquet download
- **Higher replay limits** and faster seek
- **Saved replay links** for incidents and events
- **High-resolution timelapse exports** for creators or media

#### Why this works

- Archive storage, egress, and compute are real costs
- It does not betray the public-interest live experience
- Journalists, researchers, enthusiasts, and planners are more likely to pay for history than for the basic live map

---

### 2. Pro / institutional analytics

The congestion and playback architecture points naturally to a B2B or professional layer.

Potential offerings:

- **Route/day performance reports**
- **Corridor congestion summaries**
- **Incident replay packs**
- **Custom dashboards** for councils, advocacy groups, newsrooms, and universities

The codebase already contains many raw ingredients:

- Route-snapped positions
- Speed estimates
- Replayable historical snapshots
- Route geometry
- Service alerts

The commercial value is not merely “public data access”. It is:

- **Normalized**
- **Historically queryable**
- **Visualized**
- **Shareable**
- **Stable**

That package is valuable.

---

### 3. Embeddable replay widgets for media

The shareable replay URL system strongly suggests an embed product.

Potential product features:

- “Embed this replay”
- Branded or sponsor-free iframe/player
- Incident timeline cards
- “Morning peak timelapse” embeds for articles, blogs, and local media

Potential customers:

- Local media
- Transport bloggers
- Advocacy groups
- Councils
- Event sites

This is integrity-friendly because it spreads the project without hiding the public core.

---

### 4. Supporter memberships for enthusiasts

The project’s primary audience is public transport enthusiasts, which suggests a modest but meaningful supporter model.

Example supporter benefits:

- Early access to new features
- Longer replay history
- Saved views or bookmarks
- Route watchlists
- Supporter badge
- Private changelog previews or community access
- Cosmetic extras such as themes or timelapse presets

Important constraint:

**Perks should be additive, not extractive.**
Do not turn the free version into a crippled shell.

---

### 5. Sponsorships from aligned organizations

If revenue is needed without degrading the product, use tasteful sponsorship instead of ad clutter.

Likely aligned sponsors:

- Local transport podcasts
- Rail history organizations
- Urbanism conferences
- Civic-tech groups
- Transit-adjacent events or brands

Rules for sponsorship:

- One sponsor slot
- Text or logo only
- No trackers
- Clearly separated from the map and data

---

### 6. White-label / managed hosting later

The current architecture is clean enough to support hosted or customized deployments later:

- Server-authoritative `WorldState`
- Decoupled client
- Route-shape and recording seams

Possible future offers:

- Hosted versions for another city or operator
- Newsroom kiosk mode
- Event installations
- Managed internal displays

This is real opportunity, but it is not the best starting point because it is higher-touch.

---

## What Not To Do

### Do not paywall the live vehicle map

That is the soul of the project and also the least defensible thing to charge for, since the underlying feed is public.

### Do not clutter the product with ads

This is a map and visualization product. Visual clarity is part of the value.

### Do not overbuild a generic API business too early

The architecture does not yet have auth, quotas, billing, or customer segmentation. Selling raw-feed access too early is weak unless the service adds substantial value.

### Do not present derived metrics as official truth

Speed and congestion are estimated from route-snapped snapshots and interpolation. They are valuable, but they must be labeled honestly.

---

## Most Ethical Business Model for This Project

If implemented today, the healthiest structure would be:

### Public free core

- Live map stays free
- Limited replay window
- Basic filtering and vehicle panel
- Open docs
- Public source or source-available posture

### Paid “Pro Archive”

- 90+ day history
- Bulk Parquet/CSV export
- Saved replays
- Embeddable player
- Timelapse rendering
- Priority rate limits on archive endpoints

### Paid “Institutional”

- Longer retention
- Reporting and dashboards
- Commercial embed rights
- SLAs
- Managed hosting or custom exports

### Plus voluntary support

- Donations
- Memberships
- Sponsor slot

This mix keeps the public experience intact while allowing institutions and power users to fund the system.

---

## Where To Draw The Paywall

Based on the current implementation, keep these free:

- `/ws`
- `/health`
- Standard live UI
- Route selection and vehicle panel
- Possibly a short playback window

Require auth, quotas, or payment for:

- `GET /data/snapshots/:date` full-day exports
- Long-range historical retention
- High-volume `?from=&to=` archive usage
- Future analytics and reporting endpoints
- Commercial embed features

This aligns the paywall with the costly and differentiated part of the system: the **recording and export stack**, not the public live broadcast.

---

## Strong Future Opportunity

The types and docs already anticipate richer analytics, and the project includes `TripUpdate` types. That points toward a stronger paid product later:

- Better ETA and delay analysis
- Stop-to-stop performance
- Route reliability metrics
- Incident or disruption postmortems

Those are more commercially valuable to planners, researchers, and newsrooms than a simple live dot map.

---

## Suggested Rollout Plan

### Phase 1: Revenue without compromise

- Add a **Donate / Supporter** button
- Add one tasteful sponsor slot
- Keep the current public product open and intact

### Phase 2: Paid archive

- Free: 2–7 days of replay
- Paid: 90+ days, bulk download, saved replay links
- Add auth only around archive/export endpoints

### Phase 3: Institutional tools

- Incident replay packages
- Embeddable widgets
- Scheduled performance reports
- Custom retention and hosting

---

## One-Sentence Summary

**Use the live map as the public-good front door, and charge for historical depth, exportability, analysis, and commercial convenience.**
