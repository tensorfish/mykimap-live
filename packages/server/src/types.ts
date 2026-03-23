// ── Transport modes ──

export type TransportMode = "metro" | "tram" | "bus" | "vline";

export const TRANSPORT_MODES: readonly TransportMode[] = [
  "metro", "tram", "bus", "vline",
] as const;

// ── Feed types ──

export type FeedType = "vehicle-positions" | "trip-updates" | "service-alerts";

export interface FeedDescriptor {
  mode: TransportMode;
  type: FeedType;
  url: string;
}

// ── Vehicle position (decoded + enriched) ──

export interface VehiclePosition {
  /** Unique entity ID from the feed */
  entityId: string;
  /** Transport mode */
  mode: TransportMode;
  /** Trip descriptor */
  tripId: string;
  routeId: string;
  startTime: string;
  startDate: string;
  /** Vehicle descriptor */
  vehicleId: string;
  vehicleLabel: string;
  /** Position */
  latitude: number;
  longitude: number;
  /** Bearing in degrees from true north. 0 if unavailable (trams). */
  bearing: number;
  /** Calculated speed in m/s from consecutive positions. 0 if unknown. */
  speed: number;
  /** Per-vehicle POSIX timestamp from the feed */
  timestamp: number;
  /** Whether this vehicle is considered stale (timestamp too old) */
  stale: boolean;
  /** Distance traveled along the GTFS shape polyline (meters). -1 if no shape matched. */
  shapeDistTraveled: number;
  /** The shape_id this vehicle is snapped to. Empty if unmatched. */
  shapeId: string;
}

// ── Route shapes ──

/** A single point on a shape polyline */
export interface ShapePoint {
  lat: number;
  lon: number;
  /** Cumulative distance from shape start in meters */
  dist: number;
}

/** A complete shape polyline */
export type ShapePolyline = ShapePoint[];

// ── Trip update ──

export interface StopTimePrediction {
  stopSequence: number;
  stopId: string;
  arrivalTime: number | null;
  departureTime: number | null;
  scheduleRelationship: number;
}

export interface TripUpdate {
  tripId: string;
  routeId: string;
  startTime: string;
  startDate: string;
  scheduleRelationship: number;
  stopTimeUpdates: StopTimePrediction[];
}

// ── Service alert ──

export interface ServiceAlert {
  id: string;
  cause: number;
  effect: number;
  headerText: string;
  descriptionText: string;
  url: string;
  activePeriods: Array<{ start: number; end: number }>;
  informedEntities: Array<{
    agencyId: string;
    routeId: string;
    stopId: string;
  }>;
}

// ── World state (broadcast to clients) ──

export interface WorldState {
  timestamp: number;
  vehicles: VehiclePosition[];
  alerts: ServiceAlert[];
  serverState: ServerState;
  seq: number;
}

// ── Server state machine ──

export type ServerState =
  | "BOOT"
  | "INITIALIZING"
  | "AWAITING_FIRST_POLL"
  | "RUNNING"
  | "DEGRADED"
  | "STALE"
  | "SHUTTING_DOWN"
  | "STOPPED"
  | "FATAL";

// ── Transition log entry ──

export interface TransitionLogEntry {
  timestamp: string;
  machine: "server" | "client";
  previous: string;
  new?: string;
  attempted?: string;
  rejected?: boolean;
  reason?: string;
  trigger: string;
  actor: "user" | "system" | "external";
}
