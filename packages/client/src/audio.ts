/**
 * Audio feedback module — Web Audio API, no dependencies, no files.
 *
 * Default: muted. User enables via the toggle button.
 * Preference persisted in localStorage.
 *
 * AudioContext created lazily on first user gesture (browser autoplay policy).
 */

const STORAGE_KEY = "mykimap-sound";

let ctx: AudioContext | null = null;
let muted = false;

// Restore preference
try {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "off") muted = true;
} catch {}

function getCtx(): AudioContext {
  if (!ctx) {
    ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  // Resume if suspended (browser autoplay policy)
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// ── Synthesized tones ──

function playTone(
  freq: number,
  duration: number,
  volume = 0.1,
  type: OscillatorType = "sine",
): void {
  if (muted) return;
  try {
    const c = getCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.frequency.value = freq;
    osc.type = type;
    gain.gain.setValueAtTime(volume, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
    osc.connect(gain).connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + duration);
  } catch {}
}

function playChord(
  freqs: number[],
  duration: number,
  volume = 0.06,
  type: OscillatorType = "sine",
): void {
  for (const f of freqs) playTone(f, duration, volume / freqs.length, type);
}

// ── Pre-baked sounds ──

export const sounds = {
  /** WebSocket connected → ACTIVE */
  connect() {
    playTone(660, 0.08, 0.06);
    setTimeout(() => playTone(880, 0.12, 0.07), 80);
  },

  /** Connection lost → DISCONNECTED */
  disconnect() {
    playTone(440, 0.15, 0.05);
    setTimeout(() => playTone(330, 0.25, 0.04), 120);
  },

  /** Reconnecting tick */
  reconnecting() {
    playTone(550, 0.03, 0.03, "triangle");
  },

  /** Vehicle selected */
  select() {
    playTone(1200, 0.05, 0.05, "triangle");
  },

  /** Vehicle deselected */
  deselect() {
    playTone(800, 0.04, 0.03, "triangle");
  },

  /** Mode filter toggled */
  toggle() {
    playTone(1000, 0.03, 0.05, "square");
  },

  /** New service alert */
  alert() {
    playTone(880, 0.08, 0.06);
    setTimeout(() => playTone(1100, 0.12, 0.05), 100);
  },

  /** Playback play */
  play() {
    playTone(660, 0.06, 0.05);
    setTimeout(() => playTone(880, 0.06, 0.04), 50);
  },

  /** Playback pause */
  pause() {
    playTone(880, 0.06, 0.04);
    setTimeout(() => playTone(660, 0.08, 0.03), 50);
  },

  /** Playback speed change */
  speedChange() {
    playTone(1100, 0.04, 0.04, "triangle");
  },
};

// ── Mute control ──

export function isMuted(): boolean {
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem(STORAGE_KEY, m ? "off" : "on");
  } catch {}
}

export function toggleMuted(): boolean {
  setMuted(!muted);
  return muted;
}
