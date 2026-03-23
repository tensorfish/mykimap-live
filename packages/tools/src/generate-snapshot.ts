#!/usr/bin/env bun
/**
 * Generate a synthetic DuckDB snapshot file for testing historical playback.
 *
 * Reads the GTFS Schedule shapes to get real route geometry, then simulates
 * vehicles traveling up and down their routes over a full day.
 *
 * Usage:
 *   bun run src/generate-snapshot.ts [options]
 *
 * Options:
 *   --date         Date for the snapshot (default: 2026-03-22)
 *   --output       Output directory (default: .data/snapshots)
 *   --gtfs-cache   GTFS cache directory (default: .cache/gtfs)
 *   --vehicles     Vehicles per mode (default: 30)
 *   --interval     Seconds between snapshots (default: 30)
 */

import { Database } from "duckdb";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

// ── CLI args ──

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

const PROJECT_ROOT = process.env.PROJECT_ROOT ?? process.cwd();
const DATE = arg("date", "2026-03-22");
const OUTPUT_DIR = arg("output", `${PROJECT_ROOT}/.data/snapshots`);
const GTFS_CACHE = arg("gtfs-cache", `${PROJECT_ROOT}/.cache/gtfs`);
const VEHICLES_PER_MODE = parseInt(arg("vehicles", "30"), 10);
const SNAPSHOT_INTERVAL = parseInt(arg("interval", "30"), 10);

interface ShapePoint {
  lat: number;
  lon: number;
  dist: number;
}

interface Route {
  routeId: string;
  mode: string;
  shape: ShapePoint[];
  totalDist: number;
}

// ── Load shapes from GTFS cache ──

function clean(s: string): string {
  return s.replace(/"/g, "").replace(/\r/g, "").trim();
}

function loadRoutes(): Route[] {
  const modes: Array<{ folder: string; mode: string }> = [
    { folder: "1", mode: "vline" },
    { folder: "2", mode: "metro" },
    { folder: "3", mode: "tram" },
    { folder: "4", mode: "bus" },
  ];

  const routes: Route[] = [];

  for (const { folder, mode } of modes) {
    const shapesPath = join(GTFS_CACHE, `${folder}_shapes.txt`);
    const tripsPath = join(GTFS_CACHE, `${folder}_trips.txt`);

    if (!existsSync(shapesPath) || !existsSync(tripsPath)) {
      console.warn(`Skipping ${mode}: ${shapesPath} not found. Run the server first to download GTFS data.`);
      continue;
    }

    // Parse trips to get route_id → shape_id mapping
    const tripsText = readFileSync(tripsPath, "utf-8");
    const tripsLines = tripsText.split("\n");
    const tripsHeader = tripsLines[0]!.split(",").map(clean);
    const riCol = tripsHeader.indexOf("route_id");
    const siCol = tripsHeader.indexOf("shape_id");

    const routeToShape = new Map<string, string>();
    for (let i = 1; i < tripsLines.length; i++) {
      if (!tripsLines[i]!.trim()) continue;
      const cols = tripsLines[i]!.split(",");
      const ri = clean(cols[riCol] ?? "");
      const si = clean(cols[siCol] ?? "");
      if (ri && si && !routeToShape.has(ri)) {
        routeToShape.set(ri, si);
      }
    }

    // Parse shapes
    const shapesText = readFileSync(shapesPath, "utf-8");
    const shapesLines = shapesText.split("\n");
    const shapesHeader = shapesLines[0]!.split(",").map(clean);
    const sIdCol = shapesHeader.indexOf("shape_id");
    const sLatCol = shapesHeader.indexOf("shape_pt_lat");
    const sLonCol = shapesHeader.indexOf("shape_pt_lon");
    const sSeqCol = shapesHeader.indexOf("shape_pt_sequence");
    const sDistCol = shapesHeader.indexOf("shape_dist_traveled");

    const rawShapes = new Map<string, Array<{ lat: number; lon: number; seq: number; dist: number }>>();
    for (let i = 1; i < shapesLines.length; i++) {
      if (!shapesLines[i]!.trim()) continue;
      const cols = shapesLines[i]!.split(",");
      const id = clean(cols[sIdCol] ?? "");
      const lat = parseFloat(clean(cols[sLatCol] ?? ""));
      const lon = parseFloat(clean(cols[sLonCol] ?? ""));
      const seq = parseInt(clean(cols[sSeqCol] ?? "0"), 10);
      const dist = sDistCol >= 0 ? parseFloat(clean(cols[sDistCol] ?? "0")) : -1;
      if (!id || isNaN(lat) || isNaN(lon)) continue;
      if (!rawShapes.has(id)) rawShapes.set(id, []);
      rawShapes.get(id)!.push({ lat, lon, seq, dist });
    }

    // Build shapes with cumulative distances
    const builtShapes = new Map<string, ShapePoint[]>();
    for (const [id, points] of rawShapes) {
      points.sort((a, b) => a.seq - b.seq);
      const shape: ShapePoint[] = [];
      let cumDist = 0;
      for (let j = 0; j < points.length; j++) {
        const pt = points[j]!;
        if (j > 0 && pt.dist > 0) {
          cumDist = pt.dist;
        } else if (j > 0) {
          const prev = points[j - 1]!;
          const dlat = pt.lat - prev.lat;
          const dlon = pt.lon - prev.lon;
          cumDist += Math.sqrt(dlat * dlat + dlon * dlon) * 111000;
        }
        shape.push({ lat: pt.lat, lon: pt.lon, dist: cumDist });
      }
      builtShapes.set(id, shape);
    }

    // Match routes to shapes
    for (const [routeId, shapeId] of routeToShape) {
      const shape = builtShapes.get(shapeId);
      if (shape && shape.length >= 10) {
        routes.push({
          routeId,
          mode,
          shape,
          totalDist: shape[shape.length - 1]!.dist,
        });
      }
    }
  }

  return routes;
}

function sampleShape(shape: ShapePoint[], dist: number): { lat: number; lon: number } {
  const d = Math.max(0, Math.min(dist, shape[shape.length - 1]!.dist));
  for (let i = 0; i < shape.length - 1; i++) {
    if (d >= shape[i]!.dist && d <= shape[i + 1]!.dist) {
      const segLen = shape[i + 1]!.dist - shape[i]!.dist;
      const t = segLen > 0 ? (d - shape[i]!.dist) / segLen : 0;
      return {
        lat: shape[i]!.lat + t * (shape[i + 1]!.lat - shape[i]!.lat),
        lon: shape[i]!.lon + t * (shape[i + 1]!.lon - shape[i]!.lon),
      };
    }
  }
  return { lat: shape[shape.length - 1]!.lat, lon: shape[shape.length - 1]!.lon };
}

function bearingAt(shape: ShapePoint[], dist: number): number {
  const d = Math.max(0, Math.min(dist, shape[shape.length - 1]!.dist));
  let a = shape[0]!, b = shape[1]!;
  for (let i = 0; i < shape.length - 1; i++) {
    if (d >= shape[i]!.dist && d <= shape[i + 1]!.dist) {
      a = shape[i]!; b = shape[i + 1]!; break;
    }
  }
  const dlon = b.lon - a.lon, dlat = b.lat - a.lat;
  return ((Math.atan2(dlon, dlat) * 180 / Math.PI) + 360) % 360;
}

// ── Generate simulated vehicles ──

/** Minimum route length in meters — skip short routes to avoid wiggling */
const MIN_ROUTE_LENGTH = 5000;

/** Dwell time at each terminus in seconds (wait before reversing) */
const DWELL_TIME = 120;

interface SimVehicle {
  entityId: string;
  mode: string;
  routeId: string;
  vehicleId: string;
  route: Route;
  shapeDist: number;
  speed: number; // m/s
  direction: number; // +1 or -1
  dwellRemaining: number; // seconds of dwell left at terminus
}

function createVehicles(routes: Route[]): SimVehicle[] {
  const vehicles: SimVehicle[] = [];
  const modeRoutes = new Map<string, Route[]>();

  for (const r of routes) {
    // Skip short routes — they cause rapid bouncing that looks like wiggling
    if (r.totalDist < MIN_ROUTE_LENGTH) continue;
    if (!modeRoutes.has(r.mode)) modeRoutes.set(r.mode, []);
    modeRoutes.get(r.mode)!.push(r);
  }

  // Speeds in m/s per mode
  const modeSpeeds: Record<string, number> = {
    metro: 22, // ~80 km/h
    tram: 8,   // ~30 km/h
    bus: 11,   // ~40 km/h
    vline: 28, // ~100 km/h
  };

  for (const [mode, modeRts] of modeRoutes) {
    // Sort by route length descending — prefer longer routes
    modeRts.sort((a, b) => b.totalDist - a.totalDist);

    const count = Math.min(VEHICLES_PER_MODE, modeRts.length);
    for (let i = 0; i < count; i++) {
      const route = modeRts[i % modeRts.length]!;

      // Distribute vehicles evenly along the route
      const startFraction = i / count;
      const startDist = startFraction * route.totalDist;

      // Alternate direction
      const direction = i % 2 === 0 ? 1 : -1;

      vehicles.push({
        entityId: `sim-${mode}-${i}`,
        mode,
        routeId: route.routeId,
        vehicleId: `${mode.toUpperCase()}-${String(i).padStart(3, "0")}`,
        route,
        shapeDist: startDist,
        speed: modeSpeeds[mode]! * (0.8 + Math.random() * 0.4),
        direction,
        dwellRemaining: 0,
      });
    }
  }

  return vehicles;
}

function stepVehicle(v: SimVehicle, dt: number): void {
  // If dwelling at terminus, count down and don't move
  if (v.dwellRemaining > 0) {
    v.dwellRemaining -= dt;
    return;
  }

  let remaining = v.speed * dt;

  while (remaining > 0.1) {
    if (v.direction > 0) {
      const toEnd = v.route.totalDist - v.shapeDist;
      if (remaining >= toEnd) {
        v.shapeDist = v.route.totalDist;
        remaining = 0; // stop at terminus, don't carry over
        v.direction = -1;
        v.dwellRemaining = DWELL_TIME; // wait before returning
      } else {
        v.shapeDist += remaining;
        remaining = 0;
      }
    } else {
      const toStart = v.shapeDist;
      if (remaining >= toStart) {
        v.shapeDist = 0;
        remaining = 0;
        v.direction = 1;
        v.dwellRemaining = DWELL_TIME;
      } else {
        v.shapeDist -= remaining;
        remaining = 0;
      }
    }
  }
}

// ── Main ──

async function main() {
  console.log(`Generating snapshot for ${DATE}`);
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log(`Vehicles per mode: ${VEHICLES_PER_MODE}`);
  console.log(`Snapshot interval: ${SNAPSHOT_INTERVAL}s`);
  console.log();

  // Load routes
  console.log("Loading GTFS shapes...");
  const routes = loadRoutes();
  console.log(`Loaded ${routes.length} routes`);

  if (routes.length === 0) {
    console.error("No routes found. Run the server first to download GTFS data.");
    process.exit(1);
  }

  const modeCounts = new Map<string, number>();
  for (const r of routes) modeCounts.set(r.mode, (modeCounts.get(r.mode) ?? 0) + 1);
  for (const [mode, count] of modeCounts) console.log(`  ${mode}: ${count} routes`);

  // Create vehicles
  const vehicles = createVehicles(routes);
  console.log(`Created ${vehicles.length} simulated vehicles`);

  // Create DuckDB
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const dbPath = join(OUTPUT_DIR, `${DATE}.duckdb`);

  // Remove existing
  if (existsSync(dbPath)) {
    const { unlinkSync } = await import("fs");
    unlinkSync(dbPath);
    // Also remove WAL
    try { unlinkSync(dbPath + ".wal"); } catch {}
  }

  console.log(`Creating DuckDB: ${dbPath}`);

  const db = await new Promise<any>((resolve, reject) => {
    const instance = new Database(dbPath, (err: any) => {
      if (err) reject(err);
      else resolve(instance);
    });
  });

  const conn = db.connect();

  await new Promise<void>((resolve, reject) => {
    conn.run(`
      CREATE TABLE snapshots (
        timestamp  UINTEGER,
        entity_id  VARCHAR,
        mode       VARCHAR,
        route_id   VARCHAR,
        vehicle_id VARCHAR,
        latitude   FLOAT,
        longitude  FLOAT,
        bearing    FLOAT,
        speed      FLOAT,
        stale      BOOLEAN,
        shape_dist FLOAT
      )
    `, (err: any) => err ? reject(err) : resolve());
  });

  // Simulate a full day: 00:00 to 23:59
  const baseTimestamp = Math.floor(new Date(`${DATE}T00:00:00+11:00`).getTime() / 1000); // Melbourne time
  const totalSeconds = 24 * 60 * 60;
  const totalSnapshots = Math.floor(totalSeconds / SNAPSHOT_INTERVAL);

  console.log(`Generating ${totalSnapshots} snapshots (${totalSeconds / 3600}h)...`);

  let rowCount = 0;

  function esc(s: string): string { return s.replace(/'/g, "''"); }

  for (let s = 0; s < totalSnapshots; s++) {
    const timestamp = baseTimestamp + s * SNAPSHOT_INTERVAL;

    // Build one batch INSERT per snapshot (~91 rows)
    const values: string[] = [];
    for (const v of vehicles) {
      stepVehicle(v, SNAPSHOT_INTERVAL);

      const pos = sampleShape(v.route.shape, v.shapeDist);
      const bearing = bearingAt(v.route.shape, v.shapeDist);
      const adjustedBearing = v.direction < 0 ? (bearing + 180) % 360 : bearing;

      values.push(
        `(${timestamp},'${esc(v.entityId)}','${esc(v.mode)}','${esc(v.routeId)}','${esc(v.vehicleId)}',${pos.lat},${pos.lon},${adjustedBearing},${v.speed},false,${v.shapeDist})`
      );
      rowCount++;
    }

    conn.run(`INSERT INTO snapshots VALUES ${values.join(",")}`);

    if (s % 100 === 0) {
      const pct = Math.floor((s / totalSnapshots) * 100);
      process.stdout.write(`\r  ${pct}% (${s}/${totalSnapshots} snapshots, ${rowCount} rows)`);
    }
  }

  console.log(`\r  100% — ${totalSnapshots} snapshots, ${rowCount} rows`);

  // Force WAL checkpoint so data is flushed to the .duckdb file
  console.log("Flushing to disk...");
  await new Promise<void>((resolve, reject) => {
    conn.run("CHECKPOINT", (err: any) => err ? reject(err) : resolve());
  });

  console.log(`Done: ${dbPath}`);

  // Let Bun exit naturally — don't call process.exit() or db.close()
  // which crash due to NAPI bugs. setTimeout ensures pending I/O completes.
  setTimeout(() => {}, 500);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
