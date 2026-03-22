import {
  vehiclePositionFeeds,
  tripUpdateFeeds,
  serviceAlertFeeds,
} from "../config.js";
import { fetchAllFeeds } from "./feeds.js";
import {
  decodeVehiclePositions,
  decodeTripUpdates,
  decodeServiceAlerts,
} from "./decoder.js";
import { log } from "../logger.js";
import type {
  VehiclePosition,
  TripUpdate,
  ServiceAlert,
  TransportMode,
} from "../types.js";

export interface PollResult {
  /** Whether at least one vehicle position feed succeeded */
  hasPositions: boolean;
  /** Decoded vehicle positions from all modes */
  vehicles: VehiclePosition[];
  /** Decoded trip updates from all modes */
  tripUpdates: TripUpdate[];
  /** Decoded service alerts */
  alerts: ServiceAlert[];
  /** Feed-level success/failure summary */
  feedResults: {
    succeeded: string[];
    failed: string[];
  };
}

/**
 * Execute a single poll cycle: fetch all 10 feeds in parallel,
 * decode protobuf, and return the combined result.
 */
export async function poll(): Promise<PollResult> {
  const allFeeds = [
    ...vehiclePositionFeeds,
    ...tripUpdateFeeds,
    ...serviceAlertFeeds,
  ];

  const results = await fetchAllFeeds(allFeeds);

  const vehicles: VehiclePosition[] = [];
  const tripUpdates: TripUpdate[] = [];
  const alerts: ServiceAlert[] = [];
  const succeeded: string[] = [];
  const failed: string[] = [];
  let hasPositions = false;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const feed = allFeeds[i]!;
    const label = `${feed.mode}/${feed.type}`;

    if (!result) {
      failed.push(label);
      continue;
    }

    succeeded.push(label);

    try {
      switch (feed.type) {
        case "vehicle-positions": {
          const decoded = decodeVehiclePositions(result.data, feed.mode);
          vehicles.push(...decoded.vehicles);
          hasPositions = true;
          log("debug", `Decoded ${decoded.vehicles.length} vehicles from ${label}`);
          break;
        }
        case "trip-updates": {
          const decoded = decodeTripUpdates(result.data, feed.mode);
          tripUpdates.push(...decoded);
          log("debug", `Decoded ${decoded.length} trip updates from ${label}`);
          break;
        }
        case "service-alerts": {
          const decoded = decodeServiceAlerts(result.data, feed.mode);
          alerts.push(...decoded);
          log("debug", `Decoded ${decoded.length} service alerts from ${label}`);
          break;
        }
      }
    } catch (error) {
      log("error", `Decode error for ${label}`, { error: String(error) });
      failed.push(label);
    }
  }

  log("info", `Poll complete`, {
    vehicles: vehicles.length,
    tripUpdates: tripUpdates.length,
    alerts: alerts.length,
    succeeded: succeeded.length,
    failed: failed.length,
  });

  return {
    hasPositions,
    vehicles,
    tripUpdates,
    alerts,
    feedResults: { succeeded, failed },
  };
}
