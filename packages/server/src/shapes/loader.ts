import { config } from "../config.js";
import { log } from "../logger.js";
import { haversineDistance } from "../interpolation/geo.js";
import type { ShapePolyline, ShapePoint, TransportMode } from "../types.js";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * GTFS Schedule sub-ZIP folder numbers per mode.
 * See .memory/gtfs-vic.md — GTFS Schedule structure.
 */
const MODE_FOLDERS: Record<TransportMode, string[]> = {
  vline: ["1"],
  metro: ["2"],
  tram: ["3"],
  bus: ["4", "6"],
};

/** trip_id → shape_id */
const tripToShape = new Map<string, string>();

/** route_id → shape_id (first shape found for this route — fallback for unmatched trip_ids) */
const routeToShape = new Map<string, string>();

/** shape_id → polyline with cumulative distances */
const shapeIndex = new Map<string, ShapePolyline>();

export function getShapeForTrip(tripId: string): ShapePolyline | undefined {
  const shapeId = tripToShape.get(tripId);
  if (shapeId) return shapeIndex.get(shapeId);
  return undefined;
}

/**
 * Fallback: get any shape for a route_id.
 * Used when trip_id doesn't match the static schedule (e.g. trams
 * where the schedule version segment in the trip_id changes frequently).
 */
export function getShapeForRoute(routeId: string): ShapePolyline | undefined {
  const shapeId = routeToShape.get(routeId);
  if (shapeId) return shapeIndex.get(shapeId);
  return undefined;
}

export function getShapeById(shapeId: string): ShapePolyline | undefined {
  return shapeIndex.get(shapeId);
}

export function shapeStats() {
  return { trips: tripToShape.size, shapes: shapeIndex.size, routes: routeToShape.size };
}

/**
 * Download the GTFS Schedule ZIP (if not cached), extract shapes.txt
 * and trips.txt from each mode's sub-ZIP, and build the in-memory index.
 */
export async function loadShapes(): Promise<void> {
  const cacheDir = config.gtfsCacheDir;
  mkdirSync(cacheDir, { recursive: true });

  const zipPath = join(cacheDir, "gtfs.zip");

  // Download if not cached
  if (!existsSync(zipPath)) {
    log("info", "Downloading GTFS Schedule ZIP...");
    const resp = await fetch(config.gtfsScheduleUrl);
    if (!resp.ok) {
      throw new Error(`GTFS Schedule download failed: HTTP ${resp.status}`);
    }
    const buffer = await resp.arrayBuffer();
    await Bun.write(zipPath, buffer);
    log("info", `GTFS Schedule saved (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    log("info", "Using cached GTFS Schedule ZIP");
  }

  // Extract and parse each mode's sub-ZIP
  const allFolders = new Set(Object.values(MODE_FOLDERS).flat());

  for (const folder of allFolders) {
    await extractAndParse(zipPath, folder);
  }

  log("info", `Shapes loaded`, {
    shapes: shapeIndex.size,
    trips: tripToShape.size,
    totalPoints: [...shapeIndex.values()].reduce((sum, s) => sum + s.length, 0),
  });
}

async function extractAndParse(
  zipPath: string,
  folder: string
): Promise<void> {
  const cacheDir = config.gtfsCacheDir;
  const subZipPath = join(cacheDir, `${folder}_google_transit.zip`);

  // Extract the sub-ZIP from the outer ZIP
  if (!existsSync(subZipPath)) {
    const proc = Bun.spawn(
      ["unzip", "-o", "-j", zipPath, `${folder}/google_transit.zip`, "-d", cacheDir],
      { stdout: "ignore", stderr: "ignore" }
    );
    await proc.exited;

    // Rename to avoid collision between folders
    const extracted = join(cacheDir, "google_transit.zip");
    if (existsSync(extracted)) {
      await Bun.write(subZipPath, Bun.file(extracted));
      const { unlinkSync } = await import("fs");
      unlinkSync(extracted);
    }
  }

  if (!existsSync(subZipPath)) {
    log("warn", `Sub-ZIP for folder ${folder} not found, skipping`);
    return;
  }

  // Extract trips.txt and shapes.txt from the sub-ZIP
  const tripsPath = join(cacheDir, `${folder}_trips.txt`);
  const shapesPath = join(cacheDir, `${folder}_shapes.txt`);

  if (!existsSync(tripsPath)) {
    const proc = Bun.spawn(
      ["unzip", "-o", "-p", subZipPath, "trips.txt"],
      { stdout: "pipe", stderr: "ignore" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    await Bun.write(tripsPath, text);
  }

  if (!existsSync(shapesPath)) {
    const proc = Bun.spawn(
      ["unzip", "-o", "-p", subZipPath, "shapes.txt"],
      { stdout: "pipe", stderr: "ignore" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    await Bun.write(shapesPath, text);
  }

  /** Strip quotes and \r from a CSV field */
  const clean = (s: string | undefined) => (s ?? "").replace(/"/g, "").replace(/\r/g, "").trim();

  // Parse trips.txt → tripToShape
  log("info", `Parsing trips for folder ${folder}...`);
  const tripsText = await Bun.file(tripsPath).text();
  const tripsLines = tripsText.split("\n");
  const tripsHeader = tripsLines[0]!.replace(/^\uFEFF/, "").split(",").map(clean);
  const tripIdCol = tripsHeader.indexOf("trip_id");
  const shapeIdCol = tripsHeader.indexOf("shape_id");
  const routeIdCol = tripsHeader.indexOf("route_id");

  if (tripIdCol === -1 || shapeIdCol === -1) {
    log("warn", `trips.txt for folder ${folder} missing columns (got: ${tripsHeader.join(",")}), skipping`);
    return;
  }

  for (let i = 1; i < tripsLines.length; i++) {
    const line = tripsLines[i]!;
    if (!line.trim()) continue;
    const cols = line.split(",");
    const tripId = clean(cols[tripIdCol]);
    const shapeId = clean(cols[shapeIdCol]);
    const routeId = routeIdCol !== -1 ? clean(cols[routeIdCol]) : "";
    if (tripId && shapeId) {
      tripToShape.set(tripId, shapeId);
      // Store first shape per route as fallback (for trams whose trip_ids don't match)
      if (routeId && !routeToShape.has(routeId)) {
        routeToShape.set(routeId, shapeId);
      }
    }
  }

  // Parse shapes.txt → shapeIndex
  log("info", `Parsing shapes for folder ${folder}...`);
  const shapesText = await Bun.file(shapesPath).text();
  const shapesLines = shapesText.split("\n");
  const shapesHeader = shapesLines[0]!.replace(/^\uFEFF/, "").split(",").map(clean);
  const sIdCol = shapesHeader.indexOf("shape_id");
  const sLatCol = shapesHeader.indexOf("shape_pt_lat");
  const sLonCol = shapesHeader.indexOf("shape_pt_lon");
  const sSeqCol = shapesHeader.indexOf("shape_pt_sequence");
  const sDistCol = shapesHeader.indexOf("shape_dist_traveled");

  if (sIdCol === -1 || sLatCol === -1 || sLonCol === -1) {
    log("warn", `shapes.txt for folder ${folder} missing columns (got: ${shapesHeader.join(",")}), skipping`);
    return;
  }

  // Collect raw points grouped by shape_id
  const rawShapes = new Map<string, Array<{ lat: number; lon: number; seq: number; dist: number }>>();

  for (let i = 1; i < shapesLines.length; i++) {
    const line = shapesLines[i]!;
    if (!line.trim()) continue;
    const cols = line.split(",");
    const id = clean(cols[sIdCol]);
    const lat = parseFloat(clean(cols[sLatCol]));
    const lon = parseFloat(clean(cols[sLonCol]));
    const seq = parseInt(clean(cols[sSeqCol]) || "0", 10);
    const dist = sDistCol !== -1 ? parseFloat(clean(cols[sDistCol]) || "0") : -1;

    if (!id || isNaN(lat) || isNaN(lon)) continue;

    let arr = rawShapes.get(id);
    if (!arr) {
      arr = [];
      rawShapes.set(id, arr);
    }
    arr.push({ lat, lon, seq, dist });
  }

  // Sort by sequence, compute cumulative distance if not provided
  for (const [id, points] of rawShapes) {
    points.sort((a, b) => a.seq - b.seq);

    const polyline: ShapePoint[] = [];
    let cumDist = 0;

    for (let j = 0; j < points.length; j++) {
      const pt = points[j]!;

      if (j > 0) {
        const prev = points[j - 1]!;
        if (pt.dist > 0 && prev.dist > 0) {
          cumDist = pt.dist;
        } else {
          cumDist += haversineDistance(prev.lat, prev.lon, pt.lat, pt.lon);
        }
      }

      polyline.push({ lat: pt.lat, lon: pt.lon, dist: cumDist });
    }

    // Only store shapes we don't already have (avoids duplicates across folders)
    if (!shapeIndex.has(id)) {
      shapeIndex.set(id, polyline);
    }
  }
}
