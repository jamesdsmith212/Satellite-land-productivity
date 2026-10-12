import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { HISTORY_COLUMNS, validateFarmInput } from "./validate-farm-input.mjs";

const checkOnly = process.argv[2] === "--check";
const args = process.argv.slice(checkOnly ? 3 : 2);
const [workspaceArgument, boundariesPath, historyPath] = args;

if (args.length !== 3 || !workspaceArgument || !boundariesPath || !historyPath) {
  throw new Error(
    "Usage: node scripts/import-farm-data.mjs [--check] <farm-workspace> <boundaries.geojson> <history.tsv>",
  );
}

const workspace = path.resolve(workspaceArgument);
const profile = JSON.parse(
  await readFile(path.join(workspace, "profile.json"), "utf8"),
);
const fieldAliases = profile.fieldAliases ?? {};
const expected = profile.expected ?? {};

const normaliseName = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("&", "and")
    .replace(/[^a-z0-9]+/g, "");

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseTsv(value) {
  const lines = value.replaceAll("\r", "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const headers = lines[0].replace(/^\uFEFF/, "").split("\t");
  if (JSON.stringify(headers) !== JSON.stringify(HISTORY_COLUMNS)) {
    throw new Error(`History headers must match templates/history.tsv in order: ${HISTORY_COLUMNS.join(", ")}.`);
  }
  return lines.slice(1).map((line, rowIndex) => {
    const values = line.split("\t");
    if (values.length !== headers.length) {
      throw new Error(
        `History row ${rowIndex + 2} has ${values.length} columns; expected ${headers.length}.`,
      );
    }
    return Object.fromEntries(
      headers.map((header, columnIndex) => [header, values[columnIndex].trim()]),
    );
  });
}

function polygonAreaHectares(geometry) {
  const ringArea = (ring) => {
    const meanLatitude =
      ring.reduce((sum, coordinate) => sum + coordinate[1], 0) / ring.length;
    const longitudeScale = 111_320 * Math.cos((meanLatitude * Math.PI) / 180);
    const latitudeScale = 110_540;
    let twiceArea = 0;
    ring.forEach((coordinate, index) => {
      const next = ring[(index + 1) % ring.length];
      twiceArea +=
        coordinate[0] *
          longitudeScale *
          next[1] *
          latitudeScale -
        next[0] *
          longitudeScale *
          coordinate[1] *
          latitudeScale;
    });
    return Math.abs(twiceArea) / 2;
  };

  return (
    geometry.coordinates.reduce(
      (total, polygon) =>
        total +
        ringArea(polygon[0]) -
        polygon.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0),
      0,
    ) / 10_000
  );
}

const rawBoundaries = JSON.parse(await readFile(boundariesPath, "utf8"));
const rawHistory = parseTsv(await readFile(historyPath, "utf8"));
validateFarmInput(profile, rawBoundaries, rawHistory);

if (rawBoundaries.type !== "FeatureCollection") {
  throw new Error("The boundary file must be a GeoJSON FeatureCollection.");
}
if (expected.historyRows !== undefined && rawHistory.length !== expected.historyRows) {
  throw new Error(
    `Expected ${expected.historyRows} history rows; found ${rawHistory.length}.`,
  );
}

const fields = new Map();
for (const row of rawHistory) {
  const field = row.Field.trim();
  const existing = fields.get(field);
  const identity = {
    field,
    fieldCode: row["Field code"].trim(),
    hectares: positiveNumber(row.Hectares),
    acres: positiveNumber(row.Acres),
    areaYear: Number(row.Year),
  };
  if (
    existing &&
    existing.fieldCode !== identity.fieldCode
  ) {
    throw new Error(`Field identity changes within the history: ${field}.`);
  }
  if (!existing || identity.areaYear >= existing.areaYear) {
    fields.set(field, {
      ...identity,
      hectares: identity.hectares ?? existing?.hectares ?? null,
      acres: identity.acres ?? existing?.acres ?? null,
    });
  }
}

if (expected.historyFields !== undefined && fields.size !== expected.historyFields) {
  throw new Error(
    `Expected ${expected.historyFields} unique history fields; found ${fields.size}.`,
  );
}

const fieldsByNormalisedName = new Map(
  [...fields.values()].map((field) => [normaliseName(field.field), field]),
);
if (fieldsByNormalisedName.size !== fields.size) {
  throw new Error("History field names collide after normalisation. Review field identities before importing.");
}
const boundaryMatches = new Map();
const aliasReport = [];

for (const feature of rawBoundaries.features) {
  if (feature.geometry?.type !== "MultiPolygon") {
    throw new Error(
      `Boundary ${feature.properties?.field_name ?? "<unnamed>"} is not a MultiPolygon.`,
    );
  }
  const boundaryName = feature.properties.field_name;
  const alias = fieldAliases[boundaryName];
  const field = alias
    ? fields.get(alias)
    : fieldsByNormalisedName.get(normaliseName(boundaryName));
  if (!field) {
    throw new Error(`No history field matches boundary: ${boundaryName}.`);
  }
  if (boundaryMatches.has(field.field)) {
    throw new Error(`More than one boundary maps to history field: ${field.field}.`);
  }
  boundaryMatches.set(field.field, feature);
  if (alias) {
    const polygonHectares = polygonAreaHectares(feature.geometry);
    aliasReport.push({
      boundaryName,
      historyField: field.field,
      fieldCode: field.fieldCode,
      polygonHectares: Number(polygonHectares.toFixed(2)),
      recordedHectares: field.hectares,
      differenceHectares:
        field.hectares === null
          ? null
          : Number(Math.abs(polygonHectares - field.hectares).toFixed(2)),
    });
  }
}

if (
  (expected.boundaryFeatures !== undefined &&
    boundaryMatches.size !== expected.boundaryFeatures) ||
  (expected.aliasMatches !== undefined &&
    aliasReport.length !== expected.aliasMatches)
) {
  throw new Error(
    `Boundary expectations failed: found ${boundaryMatches.size} matches and ${aliasReport.length} aliases.`,
  );
}

const historyRows = rawHistory.map((row) => {
  const field = fields.get(row.Field.trim());
  const boundary = boundaryMatches.get(field.field);
  return {
    field: field.field,
    fieldYear: row.Field_Year,
    fieldCode: field.fieldCode,
    hectares: positiveNumber(row.Hectares),
    acres: positiveNumber(row.Acres),
    year: Number(row.Year),
    crop: row.Crop,
    cropNormalised: row.crop_normalised,
    cropSimplified: row.crop_simplified,
    variety: row.Variety,
    cropVariety: row["Crop/variety"],
    boundaryUuid: boundary?.properties.uuid ?? null,
    boundaryName: boundary?.properties.field_name ?? null,
  };
});

const currentHistoryByField = new Map(
  historyRows
    .filter((row) => row.year === profile.currentHarvestYear)
    .map((row) => [row.field, row]),
);

const enrichedBoundaries = {
  ...rawBoundaries,
  name: profile.boundaryLabel,
  features: rawBoundaries.features.map((feature) => {
    const boundaryName = feature.properties.field_name;
    const historyField =
      fieldAliases[boundaryName] ??
      fieldsByNormalisedName.get(normaliseName(boundaryName)).field;
    const field = fields.get(historyField);
    const currentHistory = currentHistoryByField.get(historyField);
    return {
      ...feature,
      properties: {
        ...feature.properties,
        history_field_name: historyField,
        field_code: field.fieldCode,
        recorded_hectares: currentHistory?.hectares ?? field.hectares,
        recorded_acres: currentHistory?.acres ?? field.acres,
        current_harvest_year: profile.currentHarvestYear,
        crop_current: currentHistory?.cropNormalised || null,
        crop_source_current: currentHistory?.crop || null,
        variety_current: currentHistory?.variety || null,
        boundary_version: `${profile.boundaryVersionPrefix}:${feature.properties.uuid}`,
        match_type: fieldAliases[boundaryName] ? "explicit-alias" : "exact-name",
      },
    };
  }),
};

const historyOnlyFields = [...fields.values()]
  .filter((field) => !boundaryMatches.has(field.field))
  .sort((left, right) => left.field.localeCompare(right.field));
const cropCounts = Object.entries(
  historyRows.reduce((counts, row) => {
    const crop = row.cropNormalised || "unknown";
    counts[crop] = (counts[crop] ?? 0) + 1;
    return counts;
  }, {}),
)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([crop, count]) => ({ crop, count }));

const report = {
  source: {
    boundaries: path.resolve(boundariesPath),
    history: path.resolve(historyPath),
  },
  generatedAt: new Date().toISOString(),
  historyRows: historyRows.length,
  historyFields: fields.size,
  boundaryFeatures: rawBoundaries.features.length,
  exactBoundaryMatches: boundaryMatches.size - aliasReport.length,
  aliasBoundaryMatches: aliasReport,
  historyOnlyFields,
  yearRange: {
    start: Math.min(...historyRows.map((row) => row.year)),
    end: Math.max(...historyRows.map((row) => row.year)),
  },
  cropCounts,
  missingWeatherRows: historyRows.length,
  missingSowingDateRows: historyRows.length,
  missingHarvestDateRows: historyRows.length,
  missingSatelliteRows: historyRows.length,
};

const sourceDirectory = path.join(workspace, "source");
if (!checkOnly) {
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(
    path.join(sourceDirectory, "history.json"),
    `${JSON.stringify(historyRows, null, 2)}\n`,
  );
  await writeFile(
    path.join(sourceDirectory, "import-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(
    path.join(sourceDirectory, "boundaries.geojson"),
    `${JSON.stringify(enrichedBoundaries)}\n`,
  );
}

console.log(
  JSON.stringify(
    {
      historyRows: report.historyRows,
      historyFields: report.historyFields,
      boundaryFeatures: report.boundaryFeatures,
      exactBoundaryMatches: report.exactBoundaryMatches,
      aliasBoundaryMatches: report.aliasBoundaryMatches.length,
      historyOnlyFields: report.historyOnlyFields.length,
      ...(checkOnly ? {
        validated: true,
        filesWritten: 0,
        warnings: [
          `${historyRows.filter((row) => row.cropNormalised === "unknown").length} crop-years have unknown crops.`,
          `${historyOnlyFields.length} history fields have no supplied boundary and cannot be mapped.`,
          "Sowing/harvest dates and management notes are not imported by this TSV format; retain them in the preparation review.",
          "Historical boundary versions are not supplied by this single-boundary import; historical maps use the supplied footprint.",
          "Structural validation does not verify document extraction, crop truth, polygon topology or historical geometry. Review these before import.",
        ],
      } : {}),
    },
    null,
    2,
  ),
);
