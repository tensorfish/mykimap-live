import { Database } from "duckdb";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { VehiclePosition } from "../types.js";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

// duckdb Node bindings use callbacks. We wrap them in promises.
// NOTE: db.close() crashes Bun (NAPI bug). We skip it — process exit handles cleanup.

let db: any = null;
let currentDateStr = "";

function melbourneDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: config.timezone });
}

function dbPath(dateStr: string): string {
  return join(config.recordingDataDir, `${dateStr}.duckdb`);
}

function runAsync(connection: any, sql: string, ...params: any[]): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.run(sql, ...params, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function allAsync(connection: any, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    connection.all(sql, (err: any, rows: any[]) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function openDbAsync(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const instance = new Database(path, (err: any) => {
      if (err) reject(err);
      else resolve(instance);
    });
  });
}

async function initDb(dateStr: string): Promise<void> {
  // Don't close old DB — Bun crashes on duckdb close().
  // Process exit handles cleanup. Memory is tiny.

  const path = dbPath(dateStr);
  db = await openDbAsync(path);
  const conn = db.connect();

  await runAsync(conn, `
    CREATE TABLE IF NOT EXISTS snapshots (
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
  `);

  currentDateStr = dateStr;
  log("info", `DuckDB initialized: ${path}`);
}

async function ensureCurrentDb(): Promise<void> {
  const today = melbourneDate();
  if (today !== currentDateStr) {
    await initDb(today);
  }
}

// ── Public API ──

export async function initRecorder(): Promise<void> {
  if (!config.recordingEnabled) return;
  mkdirSync(config.recordingDataDir, { recursive: true });
  cleanRetention();
  await initDb(melbourneDate());
}

export async function recordSnapshot(vehicles: VehiclePosition[], headerTimestamp: number): Promise<void> {
  if (!config.recordingEnabled || !db) return;
  await ensureCurrentDb();
  if (vehicles.length === 0) return;

  try {
    const conn = db.connect();
    const stmt = conn.prepare(
      `INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const v of vehicles) {
      stmt.run(
        headerTimestamp, v.entityId, v.mode, v.routeId, v.vehicleId,
        v.latitude, v.longitude, v.bearing, v.speed, v.stale, v.shapeDistTraveled
      );
    }

    stmt.finalize();
    log("debug", `Recorded ${vehicles.length} vehicles to DuckDB`);
  } catch (error) {
    log("error", `DuckDB insert failed: ${error}`);
  }
}

export function listRecordingDates(): string[] {
  if (!existsSync(config.recordingDataDir)) return [];
  return readdirSync(config.recordingDataDir)
    .filter((f) => f.endsWith(".duckdb"))
    .map((f) => f.replace(".duckdb", ""))
    .sort();
}

export async function exportParquet(dateStr: string): Promise<string | null> {
  const path = dbPath(dateStr);
  if (!existsSync(path)) return null;

  const exportPath = join(config.recordingDataDir, `${dateStr}.parquet`);

  // If parquet already exists and it's not today (today's DB is still being written to),
  // serve the cached export
  const today = melbourneDate();
  if (existsSync(exportPath) && dateStr !== today) {
    return exportPath;
  }

  try {
    if (dateStr === today && db) {
      log("info", `Exporting today's Parquet using active DB connection`);
      const conn = db.connect();
      await runAsync(conn, `COPY snapshots TO '${exportPath}' (FORMAT PARQUET)`);
    } else {
      log("info", `Exporting Parquet for ${dateStr} from file`);
      const exportDb = await openDbAsync(path);
      const conn = exportDb.connect();
      await runAsync(conn, `COPY snapshots TO '${exportPath}' (FORMAT PARQUET)`);
    }
    log("info", `Parquet exported: ${exportPath}`);
    return exportPath;
  } catch (error) {
    log("error", `Parquet export failed for ${dateStr}: ${error}`);
    // If re-export failed but an old parquet exists, serve it anyway
    if (existsSync(exportPath)) {
      log("warn", `Serving stale Parquet for ${dateStr}`);
      return exportPath;
    }
    return null;
  }
}

function cleanRetention(): void {
  if (!existsSync(config.recordingDataDir)) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.recordingRetentionDays);
  const cutoffStr = cutoff.toLocaleDateString("en-CA", { timeZone: config.timezone });

  for (const file of readdirSync(config.recordingDataDir).filter((f) => f.endsWith(".duckdb"))) {
    const dateStr = file.replace(".duckdb", "");
    if (dateStr < cutoffStr) {
      try { unlinkSync(join(config.recordingDataDir, file)); log("info", `Deleted old recording: ${file}`); } catch {}
    }
  }
}

export async function closeRecorder(): Promise<void> {
  // Skip db.close() — crashes Bun. Process exit handles cleanup.
  db = null;
}
