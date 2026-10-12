import contract from "../schemas/farm-ingestion.json" with { type: "json" };

export const HISTORY_COLUMNS = contract.history.columns;

function validYear(value) {
  return /^\d{4}$/.test(String(value)) &&
    Number(value) >= contract.history.yearRange[0] &&
    Number(value) <= contract.history.yearRange[1];
}

export function validateFarmInput(profile, boundaries, rows) {
  for (const key of contract.profile.requiredStrings) {
    if (typeof profile[key] !== "string" || !profile[key].trim()) {
      throw new Error(`Profile requires a non-empty ${key}.`);
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.id)) {
    throw new Error("Profile id must use lowercase letters, numbers and hyphens.");
  }
  if (!Number.isInteger(profile.currentHarvestYear) || !validYear(profile.currentHarvestYear)) {
    throw new Error("Profile currentHarvestYear must be an integer harvest year.");
  }
  if (!/^EPSG:(326|327)(0[1-9]|[1-5][0-9]|60)$/.test(profile.crs)) {
    throw new Error("Profile crs must be a local metric WGS84 UTM code (EPSG:326xx or EPSG:327xx).");
  }
  if (profile.fieldAliases !== undefined && (
    !profile.fieldAliases || Array.isArray(profile.fieldAliases) ||
    typeof profile.fieldAliases !== "object" ||
    Object.entries(profile.fieldAliases).some(([key, value]) =>
      !key.trim() || typeof value !== "string" || !value.trim())
  )) throw new Error("Profile fieldAliases must map boundary names to history field names.");
  if (profile.expected !== undefined && (
    !profile.expected || Array.isArray(profile.expected) || typeof profile.expected !== "object" ||
    Object.values(profile.expected).some((value) => !Number.isInteger(value) || value < 0)
  )) throw new Error("Profile expected counts must be non-negative integers.");

  if (!rows.length) throw new Error("History must contain at least one crop-year row.");
  const seasons = new Set();
  const fieldCodes = new Map();
  for (const [index, row] of rows.entries()) {
    const label = `History row ${index + 2}`;
    for (const column of contract.history.requiredValues) {
      if (!row[column]) throw new Error(`${label} requires ${column}.`);
    }
    if (!validYear(row.Year)) throw new Error(`${label} Year must be a four-digit harvest year.`);
    for (const column of ["Hectares", "Acres"]) {
      if (row[column] && (!Number.isFinite(Number(row[column])) || Number(row[column]) < 0)) {
        throw new Error(`${label} ${column} must be a non-negative number or blank.`);
      }
    }
    const group = contract.history.cropGroups[row.crop_normalised];
    if (!Object.hasOwn(contract.history.cropGroups, row.crop_normalised)) {
      throw new Error(`${label} has an unsupported crop_normalised; use the contract or unknown.`);
    }
    if (row.crop_simplified !== group) {
      throw new Error(`${label} crop_simplified must be ${group} for ${row.crop_normalised}.`);
    }
    const season = JSON.stringify([row["Field code"], row.Year]);
    if (seasons.has(season)) {
      throw new Error(`${label} duplicates a field code and harvest year. Resolve conflicting crops or split-field geometry before importing.`);
    }
    seasons.add(season);
    const previousName = fieldCodes.get(row["Field code"]);
    if (previousName && previousName !== row.Field) {
      throw new Error(`${label} uses one field code for different names. Review and standardise field identity.`);
    }
    fieldCodes.set(row["Field code"], row.Field);
  }

  if (boundaries?.type !== "FeatureCollection" || !Array.isArray(boundaries.features) || !boundaries.features.length) {
    throw new Error("The boundary file must be a non-empty GeoJSON FeatureCollection.");
  }
  const uuids = new Set();
  for (const [index, feature] of boundaries.features.entries()) {
    const label = `Boundary feature ${index + 1}`;
    for (const key of contract.boundaries.requiredProperties) {
      if (typeof feature.properties?.[key] !== "string" || !feature.properties[key].trim()) {
        throw new Error(`${label} requires a non-empty properties.${key}.`);
      }
    }
    if (uuids.has(feature.properties.uuid)) throw new Error(`${label} has a duplicate uuid.`);
    uuids.add(feature.properties.uuid);
    const polygons = feature.geometry?.coordinates;
    if (feature.type !== "Feature" || feature.geometry?.type !== "MultiPolygon" || !Array.isArray(polygons) || !polygons.length) {
      throw new Error(`${label} must be a MultiPolygon Feature.`);
    }
    for (const polygon of polygons) {
      if (!Array.isArray(polygon) || !polygon.length) throw new Error(`${label} has an empty polygon.`);
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 4 || ring.some((point) =>
          !Array.isArray(point) || point.length < 2 ||
          !Number.isFinite(point[0]) || Math.abs(point[0]) > 180 ||
          !Number.isFinite(point[1]) || Math.abs(point[1]) > 90) ||
          ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) {
          throw new Error(`${label} requires closed rings of WGS84 longitude/latitude positions.`);
        }
      }
    }
  }
}
