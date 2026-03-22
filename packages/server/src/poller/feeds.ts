import type { FeedDescriptor } from "../types.js";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * Fetch a single GTFS-RT feed and return the raw protobuf bytes.
 * Returns null on failure (caller decides how to handle).
 */
export async function fetchFeed(
  feed: FeedDescriptor
): Promise<{ feed: FeedDescriptor; data: Uint8Array } | null> {
  try {
    const response = await fetch(feed.url, {
      headers: {
        KeyID: config.apiKey,
      },
    });

    if (!response.ok) {
      log("warn", `Feed fetch failed: ${feed.mode}/${feed.type}`, {
        status: response.status,
      });
      return null;
    }

    const buffer = await response.arrayBuffer();
    return { feed, data: new Uint8Array(buffer) };
  } catch (error) {
    log("error", `Feed fetch error: ${feed.mode}/${feed.type}`, {
      error: String(error),
    });
    return null;
  }
}

/**
 * Fetch all feeds in parallel.
 * Returns results for feeds that succeeded; nulls for failures.
 */
export async function fetchAllFeeds(
  feeds: FeedDescriptor[]
): Promise<Array<{ feed: FeedDescriptor; data: Uint8Array } | null>> {
  return Promise.all(feeds.map(fetchFeed));
}
