import historyData from "../data/active-farm/history.json" with { type: "json" };
import ndviData from "../data/active-farm/ndvi-summary.json" with { type: "json" };
import performanceData from "../data/active-farm/performance-summary.json" with { type: "json" };
import profileData from "../data/active-farm/profile.json" with { type: "json" };
import weatherData from "../data/active-farm/weather-summary.json" with { type: "json" };
import { getCrop, type FieldSeason } from "./rotation.ts";

export interface FarmProfile {
  id: string;
  name: string;
  historyLabel: string;
  boundaryLabel: string;
  boundaryVersionPrefix: string;
  currentHarvestYear: number;
  defaultFieldCode?: string;
  crs: string;
  expected?: {
    historyRows?: number;
    historyFields?: number;
    boundaryFeatures?: number;
    aliasMatches?: number;
  };
}

interface FarmHistoryRow {
  field: string;
  fieldYear: string;
  fieldCode: string;
  hectares: number | null;
  acres: number | null;
  year: number;
  crop: string;
  cropNormalised: string;
  cropSimplified: string;
  variety: string;
  cropVariety: string;
  boundaryUuid: string | null;
  boundaryName: string | null;
}

type WeatherWindowName = "winter" | "spring" | "grass" | "crop_year";

interface WeatherWindowSummary {
  lastAvailableDate: string;
  coverage: number;
  partial: boolean;
  precipitationMm?: number;
  et0Mm?: number;
  waterBalanceMm?: number;
  meanTemperatureC?: number;
  waterBalanceZ?: number;
  temperatureZ?: number;
  moistureClass?: "wet" | "dry" | "typical" | "unknown";
  temperatureClass?: "warm" | "cool" | "typical";
}

interface FarmWeatherSummary {
  source?: {
    temperatureAndSoilMoisture?: { model?: string };
    precipitationAndEt0?: { model?: string };
  };
  harvestYears: Record<
    string,
    Record<WeatherWindowName, WeatherWindowSummary>
  >;
}

interface FarmNdviSeason {
  id: string;
  windowStart: string;
  windowEnd: string;
  windowMethod: string;
  windowComplete?: boolean;
  boundaryMethod: string;
  candidateObservationCount: number;
  usableObservationCount: number;
  usableDates: string[];
  cellCoverage: number;
  dataQuality: number;
  peakMedianNdvi: number | null;
  cellUrl?: string;
}

interface FarmNdviSummary {
  seasons: FarmNdviSeason[];
}

interface FarmPerformanceSummary {
  fields: Array<{ fieldCode: string; url: string }>;
}

export const ACTIVE_FARM = profileData as FarmProfile;
const rows = historyData as FarmHistoryRow[];
const weather = weatherData as FarmWeatherSummary;
const ndvi = ndviData as FarmNdviSummary;
const performance = performanceData as FarmPerformanceSummary;
const performanceByFieldCode = new Map(
  performance.fields.map((field) => [field.fieldCode, field.url]),
);
const temperatureModel =
  weather.source?.temperatureAndSoilMoisture?.model ?? "modelled";
const moistureModel =
  weather.source?.precipitationAndEt0?.model ?? "modelled";
const WEATHER_PROVENANCE = `${moistureModel} rainfall/ET₀ and ${temperatureModel} temperature`;
const NDVI_PROVENANCE =
  "Sentinel-2 Level-2A surface reflectance via Element 84 Earth Search";
const ndviBySeasonId = new Map(
  ndvi.seasons.map((season) => [season.id, season]),
);
const ARABLE_SOURCE_CROPS = new Set([
  "spring_barley",
  "spring_beans",
  "spring_wheat",
  "winter_barley",
  "winter_beans",
  "winter_wheat",
  "winter_feed_barley",
  "winter_malting_barley",
  "spring_feed_barley",
  "spring_malting_barley",
  "winter_oats",
  "spring_oats",
  "winter_oilseed_rape",
  "spring_oilseed_rape",
]);

const fieldsWithArableHistory = new Set(
  rows
    .filter((row) => ARABLE_SOURCE_CROPS.has(row.cropNormalised))
    .map((row) => row.fieldCode),
);

export function sourceCropToTaxonomy(
  cropNormalised: string,
  fieldCode: string,
): string {
  if (cropNormalised === "grass") {
    return fieldsWithArableHistory.has(fieldCode)
      ? "temporary-grass"
      : "permanent-grass";
  }
  return getCrop(cropNormalised.replaceAll("_", "-")).code;
}

function rotationPosition(
  sourceCrop: string,
  cropCode: string,
  previousCropCode: string,
) {
  if (/^WW1$/i.test(sourceCrop)) return "First cereal";
  if (/^WW2$/i.test(sourceCrop)) return "Second cereal";

  const crop = getCrop(cropCode);
  const previousCrop = getCrop(previousCropCode);
  if (crop.group === "cereal") {
    if (previousCrop.group === "cereal") return "Consecutive cereal";
    if (["break", "grass", "fallow"].includes(previousCrop.group)) {
      return "First cereal";
    }
    return "Cereal position unknown";
  }
  if (crop.group === "break") return "Break crop";
  if (cropCode === "temporary-grass") return "Temporary grass";
  if (cropCode === "permanent-grass") return "Permanent grass";
  if (crop.group === "woodland") return "Woodland";
  if (crop.group === "fallow") return "Fallow";
  return "Unknown";
}

function weatherWindow(cropCode: string): WeatherWindowName {
  const crop = getCrop(cropCode);
  if (crop.season === "winter") return "winter";
  if (crop.season === "spring") return "spring";
  if (crop.group === "grass") return "grass";
  return "crop_year";
}

function formatSigned(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function weatherEvidence(
  cropCode: string,
  harvestYear: number,
): Pick<
  FieldSeason,
  | "weatherClass"
  | "weatherSummary"
  | "weatherWindow"
  | "weatherCoverage"
  | "waterBalanceMm"
  | "waterBalanceZ"
  | "temperatureZ"
  | "weatherProvenance"
> {
  const windowName = weatherWindow(cropCode);
  const evidence = weather.harvestYears[String(harvestYear)]?.[windowName];
  const provenance = WEATHER_PROVENANCE;
  if (!evidence) {
    return {
      weatherClass: "unknown",
      weatherSummary: "No weather summary is available for this harvest year.",
      weatherWindow: windowName,
      weatherCoverage: 0,
      waterBalanceMm: null,
      waterBalanceZ: null,
      temperatureZ: null,
      weatherProvenance: provenance,
    };
  }
  if (
    evidence.partial ||
    evidence.moistureClass === "unknown" ||
    evidence.precipitationMm === undefined ||
    evidence.et0Mm === undefined ||
    evidence.waterBalanceMm === undefined
  ) {
    return {
      weatherClass: "unknown",
      weatherSummary: `${provenance} ${windowName.replace("_", " ")} window is incomplete (${Math.round(evidence.coverage * 100)}% through ${evidence.lastAvailableDate}); no wet/dry class assigned.`,
      weatherWindow: windowName,
      weatherCoverage: evidence.coverage,
      waterBalanceMm: evidence.waterBalanceMm ?? null,
      waterBalanceZ: null,
      temperatureZ: null,
      weatherProvenance: provenance,
    };
  }
  const moistureClass = evidence.moistureClass ?? "unknown";
  const moistureComparison =
    evidence.waterBalanceZ === undefined
      ? moistureClass
      : `${moistureClass}, ${formatSigned(evidence.waterBalanceZ)} SD`;
  const temperatureComparison = evidence.temperatureClass
    ? `, ${evidence.temperatureClass}`
    : "";
  return {
    weatherClass: moistureClass,
    weatherSummary: `${provenance} ${windowName.replace("_", " ")} window: ${evidence.precipitationMm.toFixed(1)} mm rain, ${evidence.et0Mm.toFixed(1)} mm ET₀, ${formatSigned(evidence.waterBalanceMm)} mm balance (${moistureComparison}); ${evidence.meanTemperatureC?.toFixed(1) ?? "—"} °C mean${temperatureComparison}. Reanalysis, not an on-farm station.`,
    weatherWindow: windowName,
    weatherCoverage: evidence.coverage,
    waterBalanceMm: evidence.waterBalanceMm,
    waterBalanceZ: evidence.waterBalanceZ ?? null,
    temperatureZ: evidence.temperatureZ ?? null,
    weatherProvenance: provenance,
  };
}

function buildSeasons(historyRows: FarmHistoryRow[]): FieldSeason[] {
  const rowsByField = new Map<string, FarmHistoryRow[]>();
  for (const row of historyRows) {
    rowsByField.set(row.fieldCode, [
      ...(rowsByField.get(row.fieldCode) ?? []),
      row,
    ]);
  }

  const seasons: FieldSeason[] = [];
  for (const fieldRows of rowsByField.values()) {
    const sorted = [...fieldRows].sort((left, right) => left.year - right.year);
    let previousCropCode = "unknown";
    for (const row of sorted) {
      const seasonId = `${ACTIVE_FARM.id}-${row.fieldCode}-${row.year}`;
      const cropCode = sourceCropToTaxonomy(
        row.cropNormalised,
        row.fieldCode,
      );
      const notes =
        row.crop && row.crop !== row.cropNormalised
          ? `Source crop label: ${row.crop}.`
          : "";
      const linkedWeather = weatherEvidence(cropCode, row.year);
      const satellite = ndviBySeasonId.get(seasonId);
      seasons.push({
        id: seasonId,
        fieldId: row.fieldCode,
        fieldName: row.field,
        portion: "Whole field",
        boundaryVersion:
          row.year === ACTIVE_FARM.currentHarvestYear && row.boundaryUuid
            ? `${ACTIVE_FARM.boundaryVersionPrefix}:${row.boundaryUuid}`
            : row.year === ACTIVE_FARM.currentHarvestYear
              ? `No ${ACTIVE_FARM.currentHarvestYear} boundary supplied`
              : "Historical boundary not supplied",
        harvestYear: row.year,
        cropCode,
        cropTypeUse: row.cropSimplified || row.cropNormalised || "",
        variety: row.variety,
        previousCropCode,
        sowingDate: "",
        harvestDate: "",
        establishmentMethod: "",
        cultivationSystem: "",
        seedRate: "",
        endMarket: "",
        strawManagement: "",
        coverCrop: "",
        organicManure: "",
        drainageWork: "",
        notes,
        rotationPosition: rotationPosition(
          row.crop,
          cropCode,
          previousCropCode,
        ),
        ...linkedWeather,
        observationCount: satellite?.candidateObservationCount ?? 0,
        usableObservationCount: satellite?.usableObservationCount ?? 0,
        dataQuality: satellite?.dataQuality ?? 0,
        peakNdvi: satellite?.peakMedianNdvi ?? null,
        inferredStageCount: satellite?.usableObservationCount ?? 0,
        ndviWindowStart: satellite?.windowStart,
        ndviWindowEnd: satellite?.windowEnd,
        ndviWindowMethod: satellite?.windowMethod,
        ndviWindowComplete: satellite?.windowComplete,
        ndviBoundaryMethod: satellite?.boundaryMethod,
        ndviCellCoverage: satellite?.cellCoverage,
        ndviUsableDates: satellite?.usableDates,
        ndviCellUrl: satellite?.cellUrl,
        performanceFieldUrl: performanceByFieldCode.get(row.fieldCode),
        ndviProvenance: satellite
          ? NDVI_PROVENANCE
          : undefined,
        zoneScores: {},
        hectares: row.hectares,
        acres: row.acres,
        sourceCrop: row.crop,
        sourceFieldYear: row.fieldYear,
        sourceDataset: ACTIVE_FARM.historyLabel,
      });
      previousCropCode = cropCode;
    }
  }

  return seasons.sort(
    (left, right) =>
      left.fieldName.localeCompare(right.fieldName) ||
      left.harvestYear - right.harvestYear,
  );
}

export const FARM_SEASONS = buildSeasons(rows);
const farmSeasonById = new Map(
  FARM_SEASONS.map((season) => [season.id, season]),
);

export function linkFarmDerivedEvidence(record: FieldSeason): FieldSeason {
  const source = farmSeasonById.get(record.id);
  if (!source) return record;
  const currentWeather = weatherEvidence(
    record.cropCode,
    record.harvestYear,
  );
  const linkedWeather =
    record.weatherProvenance &&
    record.weatherProvenance !== WEATHER_PROVENANCE
      ? {}
      : {
        ...currentWeather,
      };
  const sourceNdvi =
    record.cropCode === source.cropCode
      ? {
          observationCount: source.observationCount,
          usableObservationCount: source.usableObservationCount,
          dataQuality: source.dataQuality,
          peakNdvi: source.peakNdvi,
          inferredStageCount: source.inferredStageCount,
          ndviWindowStart: source.ndviWindowStart,
          ndviWindowEnd: source.ndviWindowEnd,
          ndviWindowMethod: source.ndviWindowMethod,
          ndviWindowComplete: source.ndviWindowComplete,
          ndviBoundaryMethod: source.ndviBoundaryMethod,
          ndviCellCoverage: source.ndviCellCoverage,
          ndviUsableDates: source.ndviUsableDates,
          ndviCellUrl: source.ndviCellUrl,
          performanceFieldUrl: source.performanceFieldUrl,
          ndviProvenance: source.ndviProvenance,
        }
      : {
          observationCount: 0,
          usableObservationCount: 0,
          dataQuality: 0,
          peakNdvi: null,
          inferredStageCount: 0,
          ndviWindowMethod:
            "Crop was edited after the local composite was created; rerun the NDVI fetcher.",
          ndviProvenance: undefined,
        };
  const linkedNdvi =
    record.ndviProvenance && record.ndviProvenance !== NDVI_PROVENANCE
      ? {}
      : sourceNdvi;
  return {
    ...record,
    ...linkedWeather,
    ...linkedNdvi,
  };
}

export const FARM_HISTORY_ROW_COUNT = rows.length;
export const FARM_FIELD_COUNT = new Set(rows.map((row) => row.fieldCode)).size;
export const FARM_BOUNDARY_COUNT = new Set(
  rows.map((row) => row.boundaryUuid).filter(Boolean),
).size;

export const LEGACY_DEMO_SEASON_IDS = [
  "north-beck-2019",
  "north-beck-2020",
  "north-beck-2021",
  "north-beck-2022",
  "north-beck-2023",
  "north-beck-2024",
  "north-beck-2025",
  "north-beck-2026",
  "mill-close-2024",
  "mill-close-east-2025",
  "mill-close-west-2025",
  "croft-missing-2023",
];

export function isLegacyDemoDataset(seasonIds: string[]) {
  return (
    seasonIds.length === LEGACY_DEMO_SEASON_IDS.length &&
    new Set(seasonIds).size === LEGACY_DEMO_SEASON_IDS.length &&
    LEGACY_DEMO_SEASON_IDS.every((id) => seasonIds.includes(id))
  );
}
