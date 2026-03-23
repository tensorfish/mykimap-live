// ── Mirrors server types for the WebSocket payload ──

export type TransportMode = "metro" | "tram" | "bus" | "vline";

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

export interface VehiclePosition {
  entityId: string;
  mode: TransportMode;
  tripId: string;
  routeId: string;
  startTime: string;
  startDate: string;
  vehicleId: string;
  vehicleLabel: string;
  latitude: number;
  longitude: number;
  bearing: number;
  speed: number;
  timestamp: number;
  stale: boolean;
  shapeDistTraveled: number;
  shapeId: string;
}

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

export interface SegmentSpeed {
  routeId: string;
  mode: TransportMode;
  segIdx: number;
  avgSpeed: number;
  sampleCount: number;
}

export interface WorldState {
  timestamp: number;
  vehicles: VehiclePosition[];
  alerts: ServiceAlert[];
  congestion: SegmentSpeed[];
  serverState: ServerState;
  seq: number;
}

// ── Client state machine ──

export type ClientState =
  | "LOADING"
  | "CONNECTING"
  | "WAITING_FOR_DATA"
  | "ACTIVE"
  | "STALE"
  | "RECONNECTING"
  | "DISCONNECTED"
  | "ERROR";
