import type { FeedDescriptor, TransportMode, FeedType } from "./types.js";

// ── Environment ──

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

// ── Config ──

export const config = {
  /** Transport Victoria Open Data API key */
  apiKey: requireEnv("OPENDATA_VIC_API_KEY"),

  /** Server binding */
  port: parseInt(optionalEnv("SERVER_PORT", "3000"), 10),
  host: optionalEnv("SERVER_HOST", "0.0.0.0"),

  /** Polling intervals — 15s against a ~30s server-side cache means we catch each refresh within one poll */
  pollIntervalMs: parseInt(optionalEnv("POLL_INTERVAL_MS", "15000"), 10),
  broadcastIntervalMs: parseInt(
    optionalEnv("BROADCAST_INTERVAL_MS", "1000"),
    10
  ),

  /** A vehicle is considered stale if its own timestamp is older than this */
  staleVehicleThresholdMs: parseInt(
    optionalEnv("STALE_VEHICLE_THRESHOLD_MS", "120000"),
    10
  ),

  /** After this many ms without a successful poll, transition to STALE */
  stalePollThresholdMs: parseInt(
    optionalEnv("STALE_POLL_THRESHOLD_MS", "120000"),
    10
  ),

  /** Max retries for the initial poll before going FATAL */
  firstPollMaxRetries: 3,

  /**
   * All date-based file naming uses Melbourne time, not server-local time.
   * PTV schedules and service days are defined in this timezone.
   * Not configurable — this is a Melbourne transport map.
   */
  timezone: "Australia/Melbourne" as const,

  /** GTFS Schedule (static) — used for route shapes */
  gtfsScheduleUrl: optionalEnv(
    "GTFS_SCHEDULE_URL",
    "https://opendata.transport.vic.gov.au/dataset/3f4e292e-7f8a-4ffe-831f-1953be0fe448/resource/fb152201-859f-4882-9206-b768060b50ad/download/gtfs.zip"
  ),
  gtfsCacheDir: optionalEnv("GTFS_CACHE_DIR", ".cache/gtfs"),
} as const;

// ── Feed definitions ──

const BASE_URL =
  "https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1";

/**
 * All 10 available GTFS-RT feeds.
 * Bus and V/Line have no service alerts (404 confirmed).
 */
const FEED_MATRIX: Array<{ mode: TransportMode; types: FeedType[] }> = [
  {
    mode: "metro",
    types: ["vehicle-positions", "trip-updates", "service-alerts"],
  },
  {
    mode: "tram",
    types: ["vehicle-positions", "trip-updates", "service-alerts"],
  },
  { mode: "bus", types: ["vehicle-positions", "trip-updates"] },
  { mode: "vline", types: ["vehicle-positions", "trip-updates"] },
];

export const feeds: FeedDescriptor[] = FEED_MATRIX.flatMap(({ mode, types }) =>
  types.map((type) => ({
    mode,
    type,
    url: `${BASE_URL}/${mode}/${type}`,
  }))
);

export const vehiclePositionFeeds = feeds.filter(
  (f) => f.type === "vehicle-positions"
);
export const tripUpdateFeeds = feeds.filter((f) => f.type === "trip-updates");
export const serviceAlertFeeds = feeds.filter(
  (f) => f.type === "service-alerts"
);
