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
      timestamp    UINTEGER,
      entity_id    VARCHAR,
      mode         VARCHAR,
      trip_id      VARCHAR,
      route_id     VARCHAR,
      vehicle_id   VARCHAR,
      vehicle_label VARCHAR,
      latitude     FLOAT,
      longitude    FLOAT,
      bearing      FLOAT,
      speed        FLOAT,
      start_time   VARCHAR,
      start_date   VARCHAR,
      vehicle_ts   UINTEGER
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
    const esc = (s: string) => s.replace(/'/g, "''");

    const values = vehicles.map((v) =>
      `(${headerTimestamp},'${esc(v.entityId)}','${esc(v.mode)}','${esc(v.tripId)}','${esc(v.routeId)}','${esc(v.vehicleId)}','${esc(v.vehicleLabel)}',${v.latitude},${v.longitude},${v.bearing},${v.speed},'${esc(v.startTime)}','${esc(v.startDate)}',${v.timestamp})`
    ).join(",");

    conn.run(`INSERT INTO snapshots VALUES ${values}`);
    log("debug", `Recorded ${vehicles.length} vehicles to DuckDB`);
  } catch (error) {
    log("error", `DuckDB insert failed: ${error}`);
  }
}

export function listRecordingDates(): string[] {
  if (!existsSync(config.recordingDataDir)) return [];
  // Scan for .duckdb files — works regardless of RECORDING_ENABLED
  // (tools/generate-snapshot writes directly to this directory)
  const dates = new Set<string>();
  for (const f of readdirSync(config.recordingDataDir)) {
    if (f.endsWith(".duckdb") && !f.endsWith(".duckdb.wal")) {
      dates.add(f.replace(".duckdb", ""));
    }
  }
  return [...dates].sort();
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
