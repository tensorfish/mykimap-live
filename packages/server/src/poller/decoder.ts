import protobuf from "protobufjs";
import { log } from "../logger.js";
import type {
  TransportMode,
  VehiclePosition,
  TripUpdate,
  StopTimePrediction,
  ServiceAlert,
} from "../types.js";

// ── Load GTFS-RT proto schema ──

/**
 * We use the official GTFS Realtime proto definition.
 * protobufjs can load it from a .proto file or we can define it inline.
 * For simplicity, we use protobufjs reflection to decode the standard format.
 */
let FeedMessage: protobuf.Type | null = null;

export async function loadProtoSchema(): Promise<void> {
  const root = await protobuf.load(
    new URL("../../proto/gtfs-realtime.proto", import.meta.url).pathname
  );
  FeedMessage = root.lookupType("transit_realtime.FeedMessage");
  log("info", "Protobuf schema loaded");
}

function getFeedMessage(): protobuf.Type {
  if (!FeedMessage) {
    throw new Error("Proto schema not loaded. Call loadProtoSchema() first.");
  }
  return FeedMessage;
}

// ── Decode vehicle positions ──

export function decodeVehiclePositions(
  data: Uint8Array,
  mode: TransportMode
): { headerTimestamp: number; vehicles: VehiclePosition[] } {
  const msg = getFeedMessage();
  const feed = msg.decode(data) as any;

  const headerTimestamp: number = feed.header?.timestamp?.toNumber?.()
    ?? Number(feed.header?.timestamp ?? 0);

  const vehicles: VehiclePosition[] = [];

  for (const entity of feed.entity ?? []) {
    const v = entity.vehicle;
    if (!v) continue;

    const vehicleTimestamp: number = v.timestamp?.toNumber?.()
      ?? Number(v.timestamp ?? 0);

    vehicles.push({
      entityId: entity.id ?? "",
      mode,
      tripId: v.trip?.tripId ?? "",
      routeId: v.trip?.routeId ?? "",
      startTime: v.trip?.startTime ?? "",
      startDate: v.trip?.startDate ?? "",
      vehicleId: v.vehicle?.id ?? "",
      vehicleLabel: v.vehicle?.label ?? "",
      latitude: v.position?.latitude ?? 0,
      longitude: v.position?.longitude ?? 0,
      bearing: ((v.position?.bearing ?? 0) + 360) % 360, // Normalize to 0–360
      speed: 0, // Never provided by Victoria feeds — calculated later
      timestamp: vehicleTimestamp,
      stale: false, // Calculated later based on age
      shapeDistTraveled: -1, // Set during processSnapshot if shape is matched
      shapeId: "", // Set during processSnapshot
    });
  }

  return { headerTimestamp, vehicles };
}

// ── Decode trip updates ──

export function decodeTripUpdates(
  data: Uint8Array,
  _mode: TransportMode
): TripUpdate[] {
  const msg = getFeedMessage();
  const feed = msg.decode(data) as any;

  const updates: TripUpdate[] = [];

  for (const entity of feed.entity ?? []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;

    const stopTimeUpdates: StopTimePrediction[] = [];
    for (const stu of tu.stopTimeUpdate ?? []) {
      const arrivalTime = stu.arrival?.time?.toNumber?.()
        ?? Number(stu.arrival?.time ?? 0);
      const departureTime = stu.departure?.time?.toNumber?.()
        ?? Number(stu.departure?.time ?? 0);

      stopTimeUpdates.push({
        stopSequence: stu.stopSequence ?? 0,
        stopId: stu.stopId ?? "",
        arrivalTime: arrivalTime || null,
        departureTime: departureTime || null,
        scheduleRelationship: stu.scheduleRelationship ?? 0,
      });
    }

    updates.push({
      tripId: tu.trip?.tripId ?? "",
      routeId: tu.trip?.routeId ?? "",
      startTime: tu.trip?.startTime ?? "",
      startDate: tu.trip?.startDate ?? "",
      scheduleRelationship: tu.trip?.scheduleRelationship ?? 0,
      stopTimeUpdates,
    });
  }

  return updates;
}

// ── Decode service alerts ──

export function decodeServiceAlerts(
  data: Uint8Array,
  _mode: TransportMode
): ServiceAlert[] {
  const msg = getFeedMessage();
  const feed = msg.decode(data) as any;

  const alerts: ServiceAlert[] = [];

  for (const entity of feed.entity ?? []) {
    const a = entity.alert;
    if (!a) continue;

    const headerText =
      a.headerText?.translation?.[0]?.text ?? "";
    const descriptionText =
      a.descriptionText?.translation?.[0]?.text ?? "";
    const url = a.url?.translation?.[0]?.text ?? "";

    const activePeriods = (a.activePeriod ?? []).map((ap: any) => ({
      start: ap.start?.toNumber?.() ?? Number(ap.start ?? 0),
      end: ap.end?.toNumber?.() ?? Number(ap.end ?? 0),
    }));

    const informedEntities = (a.informedEntity ?? []).map((ie: any) => ({
      agencyId: ie.agencyId ?? "",
      routeId: ie.routeId ?? "",
      stopId: ie.stopId ?? "",
    }));

    alerts.push({
      id: entity.id ?? "",
      cause: a.cause ?? 0,
      effect: a.effect ?? 0,
      headerText,
      descriptionText,
      url,
      activePeriods,
      informedEntities,
    });
  }

  return alerts;
}
