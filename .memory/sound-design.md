# Sound Design

Audio feedback and ambient soundscape for the transport map.

## Architecture

All audio uses the Web Audio API — no dependencies, no audio libraries. A single `packages/client/src/audio.ts` module owns the `AudioContext` and exposes pre-baked sound functions. Mute toggle in the UI.

The `AudioContext` is created lazily on first user interaction (browser autoplay policy requires a user gesture before audio can play).

## Implementation

```typescript
// packages/client/src/audio.ts

const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
let ctx: AudioContext | null = null;
let muted = false;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioCtx();
  return ctx;
}

// Synthesized tones — no audio files needed
export function playTone(freq: number, duration: number, volume = 0.1) {
  if (muted) return;
  const c = getCtx();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.frequency.value = freq;
  osc.type = "sine";
  gain.gain.setValueAtTime(volume, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(); osc.stop(c.currentTime + duration);
}

// Pre-baked sounds
export const sounds = {
  connect:    () => playTone(880, 0.15, 0.08),
  disconnect: () => playTone(330, 0.3, 0.06),
  select:     () => playTone(1200, 0.05, 0.05),
  deselect:   () => playTone(800, 0.05, 0.04),
  alert:      () => playTone(660, 0.2, 0.07),
  tick:       () => playTone(440, 0.02, 0.01), // subliminal
  toggle:     () => playTone(1000, 0.03, 0.06),
};

export function setMuted(m: boolean) { muted = m; }
```

For the tram bell and ambient layers, load short `.mp3`/`.ogg` samples via `fetch()` + `AudioContext.decodeAudioData()` — still no dependencies needed.

## Sound Categories

### High Impact, Easy to Add

#### 1. Connection State Chimes
- Soft ascending chime when WebSocket connects → ACTIVE
- Muted low tone when connection drops → DISCONNECTED
- Subtle "reconnecting" tick loop during RECONNECTING
- Hook: `store.subscribe()` watching `clientState` changes

#### 2. Vehicle Selection Tap
- Short, soft click/tap when selecting a vehicle on the map
- Slightly different deselect sound (or same sound pitched down)
- Hook: `selectVehicle()` in `store.ts`

#### 3. Filter Toggle Clicks
- Satisfying mechanical switch sound when toggling metro/tram/bus/vline filters
- Hook: `setFilter()` calls in `filters.ts`

### High Impact, Medium Effort

#### 4. Melbourne Tram Bell
The iconic one. A single "ding-ding" tram bell sound:
- Play when zooming in close to an active tram (below zoom ~15)
- Play when selecting a tram vehicle
- Play very occasionally as ambient flavor (random, sparse, ~1 per 30s)
- The Yarra Trams bell sound is practically Melbourne's signature

#### 5. Service Alert Notification
- Soft "ping" or notification chime when a new service alert arrives
- Compare alert counts between ticks in `applyTick()` — if new alerts appear, play sound
- Different urgency tones for different alert severity levels

#### 6. Playback Transport Controls
- Tape-deck/VCR inspired sounds for play, pause, speed change
- A satisfying "clunk" for play/pause, subtle "whirr" for speed changes
- Hook: `playback-ui.ts` button handlers

### Atmospheric (the "wow" factor)

#### 7. Ambient Soundscape Tied to Zoom Level
- Zoomed out (city-wide): silence or very faint city hum
- Zoomed mid (neighborhood): soft, distant traffic murmur
- Zoomed in (street level): layered ambient — tram rumble, crossing bells, city noise
- Volume scales with zoom level via `map.getZoom()`
- Use Web Audio API to crossfade between layers

#### 8. Spatial Density Hum
- Soft ambient drone that shifts pitch/volume based on visible vehicle count
- Rush hour literally sounds busier than midnight
- Gives a visceral feel for network activity without looking at numbers

#### 9. Heartbeat Tick
- Extremely quiet, almost subliminal pulse on each server broadcast (~1/sec)
- Confirms the live feed is alive — you'd only notice it if it stopped
- Pause it during STALE state for an eerie "something's wrong" feeling

## Recommended Priority

| Priority | Sound | Why |
|---|---|---|
| 1 | Tram bell on select | Instant delight, iconic Melbourne, one sound file |
| 2 | Connection state chimes | Functional + polished, pure Web Audio (no files) |
| 3 | Ambient zoom soundscape | Transforms it from "tool" to "experience" |

## UI

Add a mute toggle button in the status bar. Default: muted (respect user, no surprise audio). User explicitly enables sound. Preference persisted in `localStorage`.
