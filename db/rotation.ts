import { env } from "cloudflare:workers";
import type { FieldSeason } from "@/lib/rotation";
import {
  ACTIVE_FARM,
  FARM_SEASONS,
  isLegacyDemoDataset,
  linkFarmDerivedEvidence,
} from "@/lib/farm-data";

const createTableSql = `
  CREATE TABLE IF NOT EXISTS field_seasons (
    record_key TEXT PRIMARY KEY NOT NULL,
    owner_key TEXT NOT NULL,
    season_id TEXT NOT NULL,
    field_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    portion TEXT NOT NULL,
    boundary_version TEXT NOT NULL,
    harvest_year INTEGER NOT NULL,
    crop_code TEXT NOT NULL,
    previous_crop_code TEXT NOT NULL,
    sowing_date TEXT NOT NULL,
    harvest_date TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const ownerIndexSql =
  "CREATE INDEX IF NOT EXISTS field_seasons_owner_idx ON field_seasons (owner_key)";
const fieldYearIndexSql =
  "CREATE INDEX IF NOT EXISTS field_seasons_field_year_idx ON field_seasons (owner_key, field_id, harvest_year)";

const schemaPromises = new WeakMap<object, Promise<void>>();
export const LOCAL_OWNER_KEY = `local-farm:${ACTIVE_FARM.id}`;

function database(): D1Database {
  if (!env.DB) {
    throw new Error("The DB binding is unavailable.");
  }
  return env.DB;
}

async function ensureSchema() {
  const db = database();
  let ready = schemaPromises.get(db);
  if (!ready) {
    ready = (async () => {
      await db.prepare(createTableSql).run();
      await db.batch([
        db.prepare(ownerIndexSql),
        db.prepare(fieldYearIndexSql),
      ]);
    })();
    schemaPromises.set(db, ready);
  }
  await ready;
}

export function ownerKey(): string {
  return LOCAL_OWNER_KEY;
}

function requireLocalOwner(key: string) {
  if (key !== LOCAL_OWNER_KEY) {
    throw new Error("Rotation storage is restricted to the active local farm.");
  }
}

function cleanRecord(record: FieldSeason): FieldSeason {
  return {
    ...record,
    id: String(record.id),
    fieldId: String(record.fieldId),
    fieldName: String(record.fieldName),
    portion: String(record.portion || "Whole field"),
    boundaryVersion: String(record.boundaryVersion || ""),
    harvestYear: Number(record.harvestYear),
    cropCode: String(record.cropCode || "unknown"),
    previousCropCode: String(record.previousCropCode || "unknown"),
    observationCount: Number(record.observationCount || 0),
    usableObservationCount: Number(record.usableObservationCount || 0),
    dataQuality: Number(record.dataQuality || 0),
    inferredStageCount: Number(record.inferredStageCount || 0),
    peakNdvi: record.peakNdvi == null ? null : Number(record.peakNdvi),
    zoneScores:
      record.zoneScores && typeof record.zoneScores === "object"
        ? record.zoneScores
        : {},
  };
}

export async function upsertSeasons(key: string, records: FieldSeason[]) {
  requireLocalOwner(key);
  await ensureSchema();
  const db = database();
  const now = new Date().toISOString();
  const statements = records.map((input) => {
    const record = cleanRecord(input);
    return db
      .prepare(
        `INSERT INTO field_seasons (
          record_key, owner_key, season_id, field_id, field_name, portion,
          boundary_version, harvest_year, crop_code, previous_crop_code,
          sowing_date, harvest_date, payload_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(record_key) DO UPDATE SET
          field_id = excluded.field_id,
          field_name = excluded.field_name,
          portion = excluded.portion,
          boundary_version = excluded.boundary_version,
          harvest_year = excluded.harvest_year,
          crop_code = excluded.crop_code,
          previous_crop_code = excluded.previous_crop_code,
          sowing_date = excluded.sowing_date,
          harvest_date = excluded.harvest_date,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      )
      .bind(
        `${key}:${record.id}`,
        key,
        record.id,
        record.fieldId,
        record.fieldName,
        record.portion,
        record.boundaryVersion,
        record.harvestYear,
        record.cropCode,
        record.previousCropCode,
        record.sowingDate,
        record.harvestDate,
        JSON.stringify(record),
        now,
      );
  });
  for (let index = 0; index < statements.length; index += 75) {
    await db.batch(statements.slice(index, index + 75));
  }
}

export async function listSeasons(key: string): Promise<FieldSeason[]> {
  requireLocalOwner(key);
  await ensureSchema();
  const db = database();
  const legacyLocal = await db
    .prepare("SELECT season_id FROM field_seasons WHERE owner_key = ?")
    .bind("local-demo")
    .all<{ season_id: string }>();
  if (isLegacyDemoDataset(legacyLocal.results.map((row) => row.season_id))) {
    await db
      .prepare("DELETE FROM field_seasons WHERE owner_key = ?")
      .bind("local-demo")
      .run();
  }
  const existing = await db
    .prepare("SELECT season_id FROM field_seasons WHERE owner_key = ?")
    .bind(key)
    .all<{ season_id: string }>();
  const existingIds = existing.results.map((row) => row.season_id);
  if (isLegacyDemoDataset(existingIds)) {
    await db
      .prepare("DELETE FROM field_seasons WHERE owner_key = ?")
      .bind(key)
      .run();
  }
  if (!existingIds.length || isLegacyDemoDataset(existingIds)) {
    await upsertSeasons(key, FARM_SEASONS);
  }
  const result = await db
    .prepare(
      "SELECT payload_json FROM field_seasons WHERE owner_key = ? ORDER BY field_name, portion, harvest_year",
    )
    .bind(key)
    .all<{ payload_json: string }>();
  return result.results.map((row) =>
    cleanRecord(linkFarmDerivedEvidence(JSON.parse(row.payload_json))),
  );
}
