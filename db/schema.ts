import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const fieldSeasons = sqliteTable(
  "field_seasons",
  {
    recordKey: text("record_key").primaryKey(),
    ownerKey: text("owner_key").notNull(),
    seasonId: text("season_id").notNull(),
    fieldId: text("field_id").notNull(),
    fieldName: text("field_name").notNull(),
    portion: text("portion").notNull(),
    boundaryVersion: text("boundary_version").notNull(),
    harvestYear: integer("harvest_year").notNull(),
    cropCode: text("crop_code").notNull(),
    previousCropCode: text("previous_crop_code").notNull(),
    sowingDate: text("sowing_date").notNull(),
    harvestDate: text("harvest_date").notNull(),
    payloadJson: text("payload_json").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("field_seasons_owner_idx").on(table.ownerKey),
    index("field_seasons_field_year_idx").on(
      table.ownerKey,
      table.fieldId,
      table.harvestYear,
    ),
  ],
);
