import {
  vehiclePositionFeeds,
  serviceAlertFeeds,
} from "../config.js";
import { fetchAllFeeds } from "./feeds.js";
import {
  decodeVehiclePositions,
  decodeServiceAlerts,
} from "./decoder.js";
import { log } from "../logger.js";
import type {
  VehiclePosition,
  ServiceAlert,
} from "../types.js";

export interface PollResult {
  hasPositions: boolean;
  headerTimestamp: number;
  vehicles: VehiclePosition[];
  alerts: ServiceAlert[];
  feedResults: {
    succeeded: string[];
    failed: string[];
  };
}

/**
 * Fetch vehicle positions + service alerts in parallel.
 * Trip updates are not fetched — they're decoded but never consumed.
 */
export async function poll(): Promise<PollResult> {
  const allFeeds = [
    ...vehiclePositionFeeds,
    ...serviceAlertFeeds,
  ];

  const results = await fetchAllFeeds(allFeeds);

  const vehicles: VehiclePosition[] = [];
  const alerts: ServiceAlert[] = [];
  const succeeded: string[] = [];
  const failed: string[] = [];
  let hasPositions = false;
  let maxHeaderTimestamp = 0;

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
          if (decoded.headerTimestamp > maxHeaderTimestamp) {
            maxHeaderTimestamp = decoded.headerTimestamp;
          }
          log("debug", `Decoded ${decoded.vehicles.length} vehicles from ${label}`);
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
    alerts: alerts.length,
    succeeded: succeeded.length,
    failed: failed.length,
  });

  return {
    hasPositions,
    headerTimestamp: maxHeaderTimestamp,
    vehicles,
    alerts,
    feedResults: { succeeded, failed },
  };
}
