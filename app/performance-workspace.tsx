"use client";

import performanceIndexData from "../data/active-farm/performance-summary.json" with { type: "json" };
import { ACTIVE_FARM } from "@/lib/farm-data";
import {
  calculateLandsatMetrics,
  sentinelScoresByLandsatCell,
  sourceAgreement,
  type GridDefinition,
  type LandsatCellMetrics,
  type LandsatPayload,
} from "@/lib/landsat-performance";
import {
  calculateCellMetrics,
  describeWeatherResponse,
  filterPerformanceSeasons,
  generateManagementZones,
  summariseField,
  type CellMetrics,
  type ComparisonMode,
  type PerformanceDate,
  type PerformanceDatePayload,
  type PerformanceFilters,
  type PerformancePayload,
  type PerformanceSeason,
  type SatelliteDateDisplay,
  type SatelliteFeature,
  type SeasonEvidenceFilter,
} from "@/lib/performance";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import styles from "./performance-workspace.module.css";

type MapLayer =
  | "performance"
  | "trend"
  | "landsat-performance"
  | "landsat-trend"
  | "source-agreement"
  | "confidence"
  | "variability"
  | "season"
  | "date"
  | "wet"
  | "dry"
  | "seasons";

interface PerformanceFieldIndex {
  fieldCode: string;
  fieldName: string;
  recordedHectares: number | null;
  cellCount: number;
  seasonCount: number;
  excludedSeasonCount?: number;
  availableYears: [number, number] | [];
  cropCodes: string[];
  url: string;
}

interface PerformanceIndex {
  farmGrid: {
    width: number;
    height: number;
    pixelSizeMetres: number;
    geotransform: [number, number, number, number, number, number];
  };
  fieldCount: number;
  seasonCount: number;
  individualDateCount: number;
  excludedSeasonCount?: number;
  sceneErrorCount?: number;
  methodVersion: string;
  radar?: {
    status: string;
    sceneCount: number;
    role: string;
    grid?: GridDefinition;
    fieldUrlTemplate?: string;
    requiredProduct: string;
  };
  landsat?: {
    status: string;
    sceneCount: number;
    availableYears: [number, number] | [];
    nativeSupportMetres: number;
    role: string;
  };
  fields: PerformanceFieldIndex[];
}

const performanceIndex = performanceIndexData as unknown as PerformanceIndex;
const CURRENT_METHOD_VERSION = "persistent-performance-v4-evidence-tiers";
const DEFAULT_FIELD_CODE =
  ACTIVE_FARM.defaultFieldCode ?? performanceIndex.fields[0]?.fieldCode;
const DEFAULT_YEAR_TO = Math.max(
  ACTIVE_FARM.currentHarvestYear,
  ...performanceIndex.fields.flatMap((field) => field.availableYears),
);
const DEFAULT_YEAR_FROM = Math.min(
  DEFAULT_YEAR_TO,
  ...performanceIndex.fields.flatMap((field) => field.availableYears),
);

const layerLabels: Record<MapLayer, string> = {
  performance: "Long-term relative performance",
  trend: "Relative improvement or worsening over time",
  "landsat-performance": "Landsat long-history performance (native 30 m)",
  "landsat-trend": "Landsat improvement or worsening (native 30 m)",
  "source-agreement": "Sentinel-2 and Landsat agreement (aligned at 30 m)",
  confidence: "Evidence confidence",
  variability: "Consistency between crop years",
  season: "One crop year (combined dates)",
  date: "One satellite date",
  wet: "Wet-year departure from usual position",
  dry: "Dry-year departure from usual position",
  seasons: "Number of crop years used",
};

const controlHelp = {
  field:
    "Choose a field directly, or open the whole-farm map and click a field there.",
  layer:
    "Choose what the cell colours mean. Long-term performance shows usual position; relative improvement or worsening shows the robust change in that position per year.",
  crop:
    "Limits the crop years included in the long-term calculation. Different crops are normalised within field and date before they are combined.",
  comparison:
    "Across selected crops looks for performance that persists through the rotation. Only one crop gives the strongest like-for-like comparison.",
  years:
    "Limits the evidence by harvest year. Winter crops are named by harvest year, not sowing year.",
  quality:
    "Excludes crop years with poorer satellite coverage or weaker crop-window evidence. A higher threshold uses fewer but better-supported years.",
  evidenceTier:
    "Full + limited uses every crop year with at least four adequate clear dates, but reduces the influence of incomplete seasons and grass. Fully bracketed uses only single-season trajectories with enough observations on both sides of peak canopy.",
  cropYear:
    "Shows the combined relative score from all usable satellite dates in one crop year. Use this before opening a single date.",
  satelliteDate:
    "Shows one cloud-masked Sentinel-2 observation that contributed to the selected crop-year composite.",
  dateValue:
    "Relative multi-index position is the value used in the composite. The individual indices and bands let you inspect the source signal. Labels show whether the analytical support is 10 m or 20 m.",
  mapDetail:
    "10 m detail shows the retained Sentinel cells. Management zones smooth nearby cells into broader practical areas.",
  zoneClasses:
    "Sets how many relative performance bands are used when creating management zones.",
  minimumZone:
    "Small isolated fragments below this area are merged into a neighbouring zone unless strong evidence supports keeping them.",
} as const;

const satelliteFeatureLabels: Record<SatelliteFeature, string> = {
  ndvi: "NDVI",
  evi2: "EVI2",
  ndre: "NDRE",
  ndwi: "NDWI / NDMI water-status index",
  rededge1: "Sentinel-2 B05 · red edge 1",
  rededge2: "Sentinel-2 B06 · red edge 2",
  rededge3: "Sentinel-2 B07 · red edge 3",
  nir08: "Sentinel-2 B8A · narrow NIR",
  swir16: "Sentinel-2 B11 · SWIR 1",
  swir22: "Sentinel-2 B12 · SWIR 2",
};

const satelliteFeatureSupport: Record<SatelliteFeature, number> = {
  ndvi: 10,
  evi2: 10,
  ndre: 20,
  ndwi: 20,
  rededge1: 20,
  rededge2: 20,
  rededge3: 20,
  nir08: 20,
  swir16: 20,
  swir22: 20,
};

const satelliteFeatures = Object.keys(
  satelliteFeatureLabels,
) as SatelliteFeature[];

function isRawSatelliteFeature(
  value: SatelliteDateDisplay,
): value is SatelliteFeature {
  return value !== "relative";
}

function HelpTip({ text }: { text: string }) {
  return (
    <span
      aria-label={`Explanation: ${text}`}
      className={styles.helpTip}
      onClick={(event) => event.stopPropagation()}
      tabIndex={0}
    >
      i
      <span className={styles.helpBubble} role="tooltip">
        {text}
      </span>
    </span>
  );
}

function ControlTitle({
  children,
  help,
}: {
  children: ReactNode;
  help: string;
}) {
  return (
    <span className={styles.controlTitle}>
      {children}
      <HelpTip text={help} />
    </span>
  );
}

function cropLabel(code: string) {
  const labels: Record<string, string> = {
    grass: "Grass",
    winter_wheat: "Winter wheat",
    spring_wheat: "Spring wheat",
    winter_barley: "Winter barley",
    spring_barley: "Spring barley",
    winter_beans: "Winter beans",
    spring_beans: "Spring beans",
    winter_oilseed_rape: "Winter oilseed rape",
    spring_oilseed_rape: "Spring oilseed rape",
  };
  return (
    labels[code] ??
    code
      .replaceAll("_", " ")
      .replace(/^./, (character) => character.toUpperCase())
  );
}

function colourForPerformance(value: number | null) {
  if (value === null) return "#a9afaa";
  if (value < 20) return "#8f2f36";
  if (value < 40) return "#d07142";
  if (value < 60) return "#dfd3a4";
  if (value < 80) return "#77a56d";
  return "#245c4b";
}

function colourForConfidence(value: number | null) {
  if (value === null || value < 25) return "#a9afaa";
  if (value < 45) return "#d8c5a2";
  if (value < 70) return "#78a799";
  return "#174d45";
}

function colourForVariability(value: number | null) {
  if (value === null) return "#a9afaa";
  if (value < 8) return "#245c4b";
  if (value < 16) return "#8eaa74";
  if (value < 24) return "#dfc46b";
  return "#a34250";
}

function colourForResponse(value: number | null) {
  if (value === null) return "#a9afaa";
  if (value < -12) return "#9a3941";
  if (value < -4) return "#d27b50";
  if (value <= 4) return "#ddd8c3";
  if (value <= 12) return "#70a89a";
  return "#205c58";
}

function colourForTrend(value: number | null) {
  if (value === null) return "#a9afaa";
  if (value < -4) return "#8f2f36";
  if (value < -1.5) return "#d07142";
  if (value <= 1.5) return "#ddd8c3";
  if (value <= 4) return "#70a89a";
  return "#205c58";
}

function colourForAgreement(value: number | null) {
  if (value === null) return "#a9afaa";
  if (value < 70) return "#8f2f36";
  if (value < 85) return "#d07142";
  if (value < 93) return "#ddd8c3";
  return "#205c58";
}

function featureThresholds(feature: SatelliteFeature) {
  if (feature === "ndre") return [0.1, 0.2, 0.3, 0.45];
  if (feature === "ndwi") return [-0.1, 0.05, 0.2, 0.35];
  if (
    ["rededge1", "rededge2", "rededge3", "nir08", "swir16", "swir22"].includes(
      feature,
    )
  ) {
    return [0.05, 0.15, 0.3, 0.5];
  }
  return [0.2, 0.4, 0.6, 0.8];
}

function colourForSatelliteFeature(
  value: number | null,
  feature: SatelliteFeature,
) {
  if (value === null) return "#a9afaa";
  const [first, second, third, fourth] = featureThresholds(feature);
  if (value < first) return "#8f5036";
  if (value < second) return "#d19a58";
  if (value < third) return "#d8d7a5";
  if (value < fourth) return "#71a56d";
  return "#1d5a45";
}

function colourForSeasons(value: number | null) {
  if (value === null || value < 2) return "#a9afaa";
  if (value < 4) return "#b9c9b3";
  if (value < 6) return "#6f9f78";
  return "#245c4b";
}

function layerValue(
  layer: MapLayer,
  metric: CellMetrics,
  selectedSeason: PerformanceSeason | undefined,
  selectedDate: PerformanceDatePayload | null,
  dayDisplay: SatelliteDateDisplay,
  index: number,
) {
  switch (layer) {
    case "trend":
      return metric.trendPerYear;
    case "confidence":
      return metric.score === null ? null : metric.confidence;
    case "variability":
      return metric.variability;
    case "season":
      return selectedSeason?.scores[index] ?? null;
    case "date":
      return isRawSatelliteFeature(dayDisplay)
        ? selectedDate?.features?.[dayDisplay]?.[index] ??
            (dayDisplay === "ndvi" ? selectedDate?.ndvi[index] : null) ??
            null
        : selectedDate?.relativeScores[index] ?? null;
    case "wet":
      return metric.wetResponse;
    case "dry":
      return metric.dryResponse;
    case "seasons":
      return metric.seasonCount;
    default:
      return metric.score;
  }
}

function layerColour(
  layer: MapLayer,
  value: number | null,
  dayDisplay: SatelliteDateDisplay,
) {
  if (layer === "date" && isRawSatelliteFeature(dayDisplay)) {
    return colourForSatelliteFeature(value, dayDisplay);
  }
  if (layer === "confidence") return colourForConfidence(value);
  if (layer === "variability") return colourForVariability(value);
  if (layer === "trend") return colourForTrend(value);
  if (layer === "landsat-trend") return colourForTrend(value);
  if (layer === "source-agreement") return colourForAgreement(value);
  if (layer === "wet" || layer === "dry") return colourForResponse(value);
  if (layer === "seasons") return colourForSeasons(value);
  return colourForPerformance(value);
}

function legendFor(layer: MapLayer, dayDisplay: SatelliteDateDisplay) {
  if (layer === "date" && isRawSatelliteFeature(dayDisplay)) {
    const [first, second, third, fourth] = featureThresholds(dayDisplay);
    const label = satelliteFeatureLabels[dayDisplay];
    return [
      ["#8f5036", `${label} below ${first.toFixed(2)}`],
      ["#d19a58", `${label} ${first.toFixed(2)}–${second.toFixed(2)}`],
      ["#d8d7a5", `${label} ${second.toFixed(2)}–${third.toFixed(2)}`],
      ["#71a56d", `${label} ${third.toFixed(2)}–${fourth.toFixed(2)}`],
      ["#1d5a45", `${label} above ${fourth.toFixed(2)}`],
      ["#a9afaa", "Cloud, shadow or invalid"],
    ];
  }
  if (layer === "date") {
    return [
      ["#8f2f36", "Very low on this date"],
      ["#d07142", "Low on this date"],
      ["#dfd3a4", "Middle of this field"],
      ["#77a56d", "High on this date"],
      ["#245c4b", "Very high on this date"],
      ["#a9afaa", "Cloud, shadow or invalid"],
    ];
  }
  if (layer === "season") {
    return [
      ["#8f2f36", "Very low this crop year"],
      ["#d07142", "Low this crop year"],
      ["#dfd3a4", "Middle of this field"],
      ["#77a56d", "High this crop year"],
      ["#245c4b", "Very high this crop year"],
      ["#a9afaa", "No usable crop-year evidence"],
    ];
  }
  if (layer === "confidence") {
    return [
      ["#a9afaa", "Not enough evidence"],
      ["#d8c5a2", "Low confidence"],
      ["#78a799", "Moderate confidence"],
      ["#174d45", "High confidence"],
    ];
  }
  if (layer === "trend" || layer === "landsat-trend") {
    return [
      ["#8f2f36", "Worsening by more than 4 points/year"],
      ["#d07142", "Worsening by 1.5–4 points/year"],
      ["#ddd8c3", "Broadly stable (within ±1.5 points/year)"],
      ["#70a89a", "Improving by 1.5–4 points/year"],
      ["#205c58", "Improving by more than 4 points/year"],
      ["#a9afaa", "Fewer than 3 usable crop years"],
    ];
  }
  if (layer === "source-agreement") {
    return [
      ["#8f2f36", "Strong disagreement (more than 30 points apart)"],
      ["#d07142", "Moderate disagreement (15–30 points apart)"],
      ["#ddd8c3", "Broad agreement (7–15 points apart)"],
      ["#205c58", "Close agreement (within 7 points)"],
      ["#a9afaa", "One source lacks persistent evidence"],
    ];
  }
  if (layer === "variability") {
    return [
      ["#245c4b", "Consistent between years"],
      ["#8eaa74", "Mostly consistent"],
      ["#dfc46b", "Variable between years"],
      ["#a34250", "Highly variable"],
    ];
  }
  if (layer === "wet" || layer === "dry") {
    const condition = layer === "wet" ? "wet years" : "dry years";
    return [
      ["#9a3941", `Much weaker in ${condition}`],
      ["#d27b50", `Slightly weaker in ${condition}`],
      ["#ddd8c3", `Little difference in ${condition}`],
      ["#70a89a", `Slightly stronger in ${condition}`],
      ["#205c58", `Much stronger in ${condition}`],
      ["#a9afaa", "No stable comparison baseline"],
    ];
  }
  if (layer === "seasons") {
    return [
      ["#a9afaa", "Fewer than 2 crop years"],
      ["#b9c9b3", "2–3 crop years"],
      ["#6f9f78", "4–5 crop years"],
      ["#245c4b", "6 or more crop years"],
    ];
  }
  return [
    ["#8f2f36", "Very low over time"],
    ["#d07142", "Low over time"],
    ["#dfd3a4", "Typical or inconsistent"],
    ["#77a56d", "High over time"],
    ["#245c4b", "Very high over time"],
    ["#a9afaa", "Not enough crop years"],
  ];
}

function legendHeading(layer: MapLayer, dayDisplay: SatelliteDateDisplay) {
  if (layer === "date" && isRawSatelliteFeature(dayDisplay)) {
    return `${satelliteFeatureLabels[dayDisplay]} on this date · native ${satelliteFeatureSupport[dayDisplay]} m support`;
  }
  if (layer === "date") return "Position within this field on this date";
  if (layer === "season") return "Position within this field for this crop year";
  if (layer === "trend") return "Robust change in relative position over time";
  if (layer === "landsat-trend") return "Landsat change in relative position · native 30 m";
  if (layer === "landsat-performance") return "Landsat long-history position · native 30 m";
  if (layer === "source-agreement") return "Agreement after Sentinel-2 is aggregated to Landsat 30 m cells";
  if (layer === "confidence") return "Strength of the supporting evidence";
  if (layer === "variability") return "Consistency from crop year to crop year";
  if (layer === "wet") return "Departure from the usual position in wet years";
  if (layer === "dry") return "Departure from the usual position in dry years";
  if (layer === "seasons") return "Crop years contributing at each cell";
  return "Long-term position within each field";
}

function legendExplanation(
  layer: MapLayer,
  dayDisplay: SatelliteDateDisplay,
) {
  if (layer === "date" && isRawSatelliteFeature(dayDisplay)) {
    const resolution = satelliteFeatureSupport[dayDisplay];
    return `${satelliteFeatureLabels[dayDisplay]} is crop- and growth-stage-dependent. Its analytical support is ${resolution} m${
      resolution === 20
        ? "; values are only replicated onto the 10 m display grid"
        : ""
    }. Use it within this field and date, not as an absolute crop or yield comparison.`;
  }
  if (layer === "date") {
    return "Each cell is ranked against the rest of this field on the selected date. This relative value contributes to the crop-year composite.";
  }
  if (layer === "season") {
    return "Usable dates are combined for the selected crop year after each date is normalised within the field.";
  }
  if (layer === "trend") {
    return "For each cell, the median slope between every pair of usable crop-season scores estimates change in within-field percentile points per year. At least three independent seasons spanning two years are required. It is descriptive, not causal: crop sequence and weather can still contribute, so use crop filters for like-for-like checks.";
  }
  if (layer === "landsat-performance") {
    return "Landsat NDVI, EVI2 and NDWI ranks are combined by crop year on the native 30 m grid. This is a separate long-history track and is never silently blended into Sentinel-2.";
  }
  if (layer === "landsat-trend") {
    return "The robust median pairwise slope uses native 30 m Landsat crop-year scores. At least three crop years spanning two years are required.";
  }
  if (layer === "source-agreement") {
    return "Sentinel-2 10 m cell centres are averaged within each native Landsat 30 m cell. Colour shows agreement between the two independent long-term relative scores; disagreement remains visible rather than being averaged away.";
  }
  if (layer === "confidence") {
    return "Confidence reflects independent crop years, usable dates, crop and weather diversity, coverage and dominance checks.";
  }
  if (layer === "variability") {
    return "Green cells hold a similar relative position across crop years. Red cells change position more often.";
  }
  if (layer === "wet" || layer === "dry") {
    return "Colours compare this cell's position in the selected weather type with its other usable crop years. One or two event years are shown only when at least three comparison years establish a stable baseline, and are labelled as observations rather than general sensitivity.";
  }
  if (layer === "seasons") {
    return "This counts independent crop years, not individual satellite images. At least two crop years are required for persistence.";
  }
  return "Colours show repeated relative position within each field after crop and date effects are controlled. They are not absolute yield.";
}

function formatLayerValue(
  layer: MapLayer,
  value: number | null,
  dayDisplay: SatelliteDateDisplay,
) {
  if (value === null) return "Insufficient evidence";
  if (layer === "date" && isRawSatelliteFeature(dayDisplay)) {
    return `${value.toFixed(3)} ${satelliteFeatureLabels[dayDisplay]}`;
  }
  if (layer === "variability") return `${value.toFixed(1)} percentile points`;
  if (layer === "trend" || layer === "landsat-trend") {
    return `${value > 0 ? "+" : ""}${value.toFixed(1)} percentile points/year`;
  }
  if (layer === "source-agreement") return `${value.toFixed(1)}% agreement`;
  if (layer === "wet" || layer === "dry") {
    return `${value > 0 ? "+" : ""}${value.toFixed(1)} percentile points`;
  }
  if (layer === "seasons") return `${Math.round(value)} crop years`;
  return `${Math.round(value)} / 100`;
}

function summariseTrend(metrics: CellMetrics[]) {
  const classified = metrics.filter((metric) => metric.trendPerYear !== null);
  const improving = classified.filter(
    (metric) => (metric.trendPerYear ?? 0) > 1.5,
  ).length;
  const worsening = classified.filter(
    (metric) => (metric.trendPerYear ?? 0) < -1.5,
  ).length;
  const percent = (count: number) =>
    classified.length ? Math.round((count / classified.length) * 100) : 0;
  return {
    classified: classified.length,
    improving: percent(improving),
    worsening: percent(worsening),
    stable: percent(classified.length - improving - worsening),
  };
}

function matchesCropFilter(season: PerformanceSeason, cropFilter: string) {
  if (cropFilter === "all") return true;
  if (cropFilter.startsWith("group:")) {
    return season.cropGroup === cropFilter.slice(6);
  }
  return season.cropCode === cropFilter;
}

function cellBoundaryPath(cells: Array<[number, number, number]>) {
  const occupied = new Set(
    cells.map(([column, row]) => `${column}:${row}`),
  );
  const commands: string[] = [];
  for (const [column, row] of cells) {
    if (!occupied.has(`${column}:${row - 1}`)) {
      commands.push(`M${column} ${row}H${column + 1}`);
    }
    if (!occupied.has(`${column + 1}:${row}`)) {
      commands.push(`M${column + 1} ${row}V${row + 1}`);
    }
    if (!occupied.has(`${column}:${row + 1}`)) {
      commands.push(`M${column + 1} ${row + 1}H${column}`);
    }
    if (!occupied.has(`${column - 1}:${row}`)) {
      commands.push(`M${column} ${row + 1}V${row}`);
    }
  }
  return commands.join("");
}

function WeatherBadge({ value }: { value: string }) {
  return (
    <span className={`${styles.weatherBadge} ${styles[value] ?? ""}`}>
      {value}
    </span>
  );
}

function CellEvidence({
  metric,
  cell,
  cellIndex,
  layer,
  selectedSeason,
  selectedDate,
  selectedDatePayload,
  dayDisplay,
}: {
  metric: CellMetrics;
  cell: [number, number, number];
  cellIndex: number;
  layer: MapLayer;
  selectedSeason?: PerformanceSeason;
  selectedDate?: PerformanceDate;
  selectedDatePayload?: PerformanceDatePayload | null;
  dayDisplay: SatelliteDateDisplay;
}) {
  const displayedFeature = isRawSatelliteFeature(dayDisplay)
    ? dayDisplay
    : "ndvi";
  const dailyFeature =
    selectedDatePayload?.features?.[displayedFeature]?.[cellIndex] ??
    (displayedFeature === "ndvi"
      ? selectedDatePayload?.ndvi[cellIndex]
      : null) ??
    null;
  const dailyRelative =
    selectedDatePayload?.relativeScores[cellIndex] ?? null;
  return (
    <div className={styles.cellEvidence}>
      <div className={styles.inspectorKicker}>
        <span>Selected 10 m cell</span>
        <span>
          {cell[0] + 1},{cell[1] + 1}
        </span>
      </div>
      <div className={styles.inspectorScore}>
        <strong>
          {layer === "trend"
            ? metric.trendPerYear === null
              ? "—"
              : `${metric.trendPerYear > 0 ? "+" : ""}${metric.trendPerYear.toFixed(1)}`
            : metric.score === null
              ? "—"
              : Math.round(metric.score)}
        </strong>
        <span>
          {layer === "trend"
            ? "relative percentile points / year"
            : "long-term relative score / 100"}
        </span>
      </div>
      {layer === "trend" && metric.trendStartYear && metric.trendEndYear && (
        <p className={styles.selectedSeasonNote}>
          Robust trend across harvest years {metric.trendStartYear}–
          {metric.trendEndYear}. Positive means this cell gained position
          relative to the rest of its field.
        </p>
      )}
      {selectedDate && selectedDatePayload && (
        <div className={styles.dayEvidence}>
          <span className={styles.miniLabel}>Individual date shown</span>
          <strong>{selectedDate.date}</strong>
          <p>
            {satelliteFeatureLabels[displayedFeature]}:{" "}
            {dailyFeature === null
              ? "cloud / invalid"
              : dailyFeature.toFixed(3)}
            {" · "}relative contribution:{" "}
            {dailyRelative === null ? "unavailable" : `${Math.round(dailyRelative)} / 100`}
          </p>
          <p>
            {selectedDate.stage} · {Math.round(selectedDate.clearFraction * 100)}%
            clear · {selectedDate.observationWeight.toFixed(2)} analytical
            weight
          </p>
          <small>
            Displaying{" "}
            {dayDisplay === "relative"
              ? "the equal multi-index relative contribution"
              : `${satelliteFeatureLabels[dayDisplay]} at native ${satelliteFeatureSupport[dayDisplay]} m analytical support`}
            .
          </small>
        </div>
      )}
      <div className={styles.inspectorMetrics}>
        <div>
          <strong>{metric.confidence}%</strong>
          <span>confidence</span>
        </div>
        <div>
          <strong>
            {metric.variability === null ? "—" : metric.variability.toFixed(1)}
          </strong>
          <span>variability</span>
        </div>
        <div>
          <strong>{metric.seasonCount}</strong>
          <span>crop years used</span>
        </div>
        <div>
          <strong>{metric.validObservations}</strong>
          <span>usable source dates</span>
        </div>
        <div>
          <strong>
            {metric.trendPerYear === null
              ? "—"
              : `${metric.trendPerYear > 0 ? "+" : ""}${metric.trendPerYear.toFixed(1)}`}
          </strong>
          <span>relative points / year</span>
        </div>
      </div>

      <div className={styles.responseList}>
        <p>
          {describeWeatherResponse(
            metric.wetResponse,
            "wet",
            metric.wetEvidenceLevel,
            metric.wetEventYears,
          )}
        </p>
        <p>
          {describeWeatherResponse(
            metric.dryResponse,
            "dry",
            metric.dryEvidenceLevel,
            metric.dryEventYears,
          )}
        </p>
      </div>

      <div className={styles.inspectorSection}>
        <span className={styles.miniLabel}>Crops represented</span>
        <div className={styles.chips}>
          {metric.cropCodes.map((crop) => (
            <span key={crop}>{cropLabel(crop)}</span>
          ))}
          {!metric.cropCodes.length && <span>None</span>}
        </div>
      </div>

      {(metric.dominantCropShare > 60 ||
        metric.dominantSeasonShare > 35) && (
        <div className={styles.warningBox}>
          {metric.dominantCropShare > 60 && metric.dominantCrop && (
            <p>
              {cropLabel(metric.dominantCrop)} contributes{" "}
              {metric.dominantCropShare}% of the weight.
            </p>
          )}
          {metric.dominantSeasonShare > 35 && metric.dominantSeason && (
            <p>
              Harvest {metric.dominantSeason} contributes{" "}
              {metric.dominantSeasonShare}% of the weight.
            </p>
          )}
        </div>
      )}

      <div className={styles.inspectorSection}>
        <span className={styles.miniLabel}>Crop-year evidence</span>
        <div className={styles.seasonEvidence}>
          {metric.evidence.map((row) => (
            <div key={row.seasonId}>
              <div>
                <strong>{row.harvestYear}</strong>
                <span>
                  {cropLabel(row.cropCode)} ·{" "}
                  {row.evidenceTier === "full-season"
                    ? "full trajectory"
                    : row.evidenceTier === "grass-seasonal"
                      ? "grass seasonal"
                      : "partial season"}
                </span>
              </div>
              <div className={styles.sparkTrack}>
                <i style={{ width: `${row.score}%` }} />
              </div>
              <b>{Math.round(row.score)}</b>
              <WeatherBadge value={row.weatherClass} />
            </div>
          ))}
          {!metric.evidence.length && (
            <p className={styles.muted}>No crop years pass the active filters.</p>
          )}
        </div>
      </div>

      {selectedSeason && (
        <>
          <p className={styles.selectedSeasonNote}>
            Evidence level: {selectedSeason.harvestYear}{" "}
            {cropLabel(selectedSeason.cropCode)}
            {selectedDate ? ` → ${selectedDate.date}` : " crop-season composite"}.{" "}
            {(selectedSeason.evidenceTier ?? "full-season") === "full-season"
              ? "Full seasonal trajectory."
              : `${selectedSeason.evidenceReason ?? "Limited seasonal coverage"}; reduced analytical weight.`}
          </p>
          {selectedSeason.phenology && (
            <div className={styles.warningBox}>
              <p>
                Estimated trajectory: green-up{" "}
                {selectedSeason.phenology.greenupDate ?? "not resolved"} · peak{" "}
                {selectedSeason.phenology.peakCanopyDate ?? "not resolved"} ·
                senescence{" "}
                {selectedSeason.phenology.senescenceOnsetDate ?? "not resolved"}.
              </p>
              <p>
                Phenology confidence {selectedSeason.phenology.confidence}% from{" "}
                {selectedSeason.phenology.observationCount} usable observations.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FarmCompositeMap({
  farmLayers,
  layer,
  dayDisplay,
  showBasemap,
  onOpenField,
}: {
  farmLayers: Array<{
    payload: PerformancePayload;
    metrics: CellMetrics[];
    seasons: PerformanceSeason[];
    boundaryPath: string;
  }>;
  layer: MapLayer;
  dayDisplay: SatelliteDateDisplay;
  showBasemap: boolean;
  onOpenField: (fieldCode: string) => void;
}) {
  const { width, height } = performanceIndex.farmGrid;
  return (
    <svg
      aria-label={`${layerLabels[layer]} map for the whole farm`}
      className={`${styles.performanceMap} ${styles.farmMap}`}
      viewBox={`-4 -4 ${width + 8} ${height + 8}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <pattern
          id="farm-map-grid"
          width="10"
          height="10"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M 10 0 L 0 0 0 10"
            fill="none"
            stroke="#83948d"
            strokeWidth="0.18"
            opacity="0.35"
          />
        </pattern>
        <pattern
          id="farm-insufficient-hatch"
          width="2"
          height="2"
          patternUnits="userSpaceOnUse"
        >
          <rect width="2" height="2" fill="#a9afaa" />
          <path
            d="M-0.5 0.5 L0.5 -0.5 M0 2 L2 0 M1.5 2.5 L2.5 1.5"
            stroke="#777f7a"
            strokeWidth="0.18"
          />
        </pattern>
      </defs>
      {showBasemap && (
        <rect
          x="-4"
          y="-4"
          width={width + 8}
          height={height + 8}
          fill="url(#farm-map-grid)"
        />
      )}
      {farmLayers.map(({ payload, metrics, boundaryPath }) => (
        <g
          aria-label={`Open ${payload.fieldName}`}
          className={styles.farmField}
          key={payload.fieldCode}
          onClick={() => onOpenField(payload.fieldCode)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              onOpenField(payload.fieldCode);
            }
          }}
          role="button"
          tabIndex={0}
          transform={`translate(${payload.gridOffset[0]} ${payload.gridOffset[1]})`}
        >
          <g className={styles.cells}>
            {payload.cells.map(([column, row], index) => {
              const metric = metrics[index];
              const value = layerValue(
                layer,
                metric,
                undefined,
                null,
                dayDisplay,
                index,
              );
              const insufficient =
                value === null ||
                ((layer !== "season" && layer !== "date") &&
                  metric.seasonCount < 2);
              return (
                <rect
                  fill={
                    insufficient
                      ? "url(#farm-insufficient-hatch)"
                      : layerColour(layer, value, dayDisplay)
                  }
                  height="1.02"
                  key={`${column}:${row}`}
                  width="1.02"
                  x={column}
                  y={row}
                >
                  <title>
                    {payload.fieldName} ·{" "}
                    {formatLayerValue(layer, value, dayDisplay)} ·{" "}
                    {metric.seasonCount} seasons
                  </title>
                </rect>
              );
            })}
          </g>
          <path
            className={styles.farmBoundary}
            d={boundaryPath}
            pointerEvents="none"
          />
        </g>
      ))}
      <g
        className={styles.northArrow}
        transform={`translate(3 ${Math.max(4, height - 14)}) scale(3)`}
      >
        <path d="M1 4V1.4M1 1.4L0.65 2M1 1.4L1.35 2" />
        <text x="1" y="0.9">
          N
        </text>
      </g>
      <g className={styles.scaleBar}>
        <line x1="5" x2="55" y1={height + 2} y2={height + 2} />
        <text x="30" y={height + 3.8}>
          500 m
        </text>
      </g>
    </svg>
  );
}

function LandsatMap({
  layers,
  layer,
  scope,
  sentinelScores,
  showBasemap,
  onOpenField,
}: {
  layers: Array<{ payload: LandsatPayload; metrics: LandsatCellMetrics[] }>;
  layer: "landsat-performance" | "landsat-trend" | "source-agreement";
  scope: "field" | "farm";
  sentinelScores: Map<string, number>;
  showBasemap: boolean;
  onOpenField: (fieldCode: string) => void;
}) {
  const grid = performanceIndex.landsat?.grid;
  if (!grid || !layers.length) return null;
  const cells = layers.flatMap(({ payload }) => payload.cells);
  const minimumColumn = Math.min(...cells.map((cell) => cell.column));
  const maximumColumn = Math.max(...cells.map((cell) => cell.column));
  const minimumRow = Math.min(...cells.map((cell) => cell.row));
  const maximumRow = Math.max(...cells.map((cell) => cell.row));
  const viewBox = scope === "farm"
    ? `-2 -2 ${grid.width + 4} ${grid.height + 4}`
    : `${minimumColumn - 2} ${minimumRow - 2} ${maximumColumn - minimumColumn + 5} ${maximumRow - minimumRow + 5}`;
  return (
    <svg
      aria-label={`${layerLabels[layer]} map`}
      className={`${styles.performanceMap} ${scope === "farm" ? styles.farmMap : ""}`}
      preserveAspectRatio="xMidYMid meet"
      viewBox={viewBox}
    >
      {showBasemap && (
        <rect
          fill="#edf0eb"
          height={grid.height + 4}
          width={grid.width + 4}
          x="-2"
          y="-2"
        />
      )}
      {layers.map(({ payload, metrics }) => (
        <g
          aria-label={`Open ${payload.field.fieldName}`}
          className={styles.farmField}
          key={payload.field.fieldCode}
          onClick={() => scope === "farm" && onOpenField(payload.field.fieldCode)}
          onKeyDown={(event) => {
            if (scope === "farm" && (event.key === "Enter" || event.key === " ")) {
              onOpenField(payload.field.fieldCode);
            }
          }}
          role={scope === "farm" ? "button" : undefined}
          tabIndex={scope === "farm" ? 0 : undefined}
        >
          {payload.cells.map((cell, index) => {
            const metric = metrics[index];
            const sentinelScore = sentinelScores.get(`${cell.row}:${cell.column}`);
            const value = layer === "landsat-trend"
              ? metric.trendPerYear
              : layer === "source-agreement"
                ? sourceAgreement(metric.score, sentinelScore)
                : metric.score;
            return (
              <rect
                fill={
                  layer === "source-agreement"
                    ? colourForAgreement(value)
                    : layer === "landsat-trend"
                      ? colourForTrend(value)
                      : colourForPerformance(value)
                }
                height="1.02"
                key={`${cell.row}:${cell.column}`}
                width="1.02"
                x={cell.column}
                y={cell.row}
              >
                <title>
                  {payload.field.fieldName} · {formatLayerValue(layer, value, "relative")} · {metric.seasonCount} Landsat crop years
                  {layer === "source-agreement" && metric.score !== null && sentinelScore !== undefined
                    ? ` · Landsat ${Math.round(metric.score)}, Sentinel-2 ${Math.round(sentinelScore)}`
                    : ""}
                </title>
              </rect>
            );
          })}
        </g>
      ))}
      <g className={styles.scaleBar}>
        <line x1={minimumColumn} x2={minimumColumn + 10} y1={maximumRow + 2} y2={maximumRow + 2} />
        <text x={minimumColumn + 5} y={maximumRow + 3.4}>300 m</text>
      </g>
    </svg>
  );
}

export function PerformanceWorkspace() {
  if (performanceIndex.methodVersion !== CURRENT_METHOD_VERSION) {
    return (
      <div className={styles.app}>
        <main className={styles.main}>
          <section className={styles.titleRow}>
            <div>
              <span className={styles.eyebrow}>Local evidence migration required</span>
              <h1>Historical maps are temporarily withheld</h1>
              <p>
                The cached optical products use an older grid or precision method.
                Refresh the local Sentinel-2 cache and rebuild performance outputs
                before using these maps for analysis.
              </p>
            </div>
          </section>
          <div className={styles.warningList}>
            <p>
              Run <code>npm run data:optical</code>, then{" "}
              <code>npm run data:performance</code> and{" "}
              <code>npm run data:database</code>. No stale score is displayed.
            </p>
          </div>
        </main>
      </div>
    );
  }
  return <CurrentPerformanceWorkspace />;
}

function CurrentPerformanceWorkspace() {
  const defaultField =
    performanceIndex.fields.find(
      (field) => field.fieldCode === DEFAULT_FIELD_CODE,
    ) ?? performanceIndex.fields[0];
  const [activeFieldCode, setActiveFieldCode] = useState(
    defaultField.fieldCode,
  );
  const [fieldSearch, setFieldSearch] = useState(defaultField.fieldName);
  const [payload, setPayload] = useState<PerformancePayload | null>(null);
  const [loadStatus, setLoadStatus] = useState("Loading local field evidence…");
  const [viewScope, setViewScope] = useState<"field" | "farm">("field");
  const [farmPayloads, setFarmPayloads] = useState<PerformancePayload[]>([]);
  const [farmLoadStatus, setFarmLoadStatus] = useState("");
  const [landsatPayloads, setLandsatPayloads] = useState<LandsatPayload[]>([]);
  const [landsatLoadStatus, setLandsatLoadStatus] = useState("");
  const [layer, setLayer] = useState<MapLayer>("performance");
  const [cropFilter, setCropFilter] = useState("all");
  const [comparisonMode, setComparisonMode] =
    useState<ComparisonMode>("all-crop");
  const [yearFrom, setYearFrom] = useState(DEFAULT_YEAR_FROM);
  const [yearTo, setYearTo] = useState(DEFAULT_YEAR_TO);
  const [minQuality, setMinQuality] = useState(60);
  const [evidenceFilter, setEvidenceFilter] =
    useState<SeasonEvidenceFilter>("include-limited");
  const [displayMode, setDisplayMode] = useState<"cells" | "zones">("cells");
  const [zoneCount, setZoneCount] = useState<3 | 4 | 5>(5);
  const [minimumZoneArea, setMinimumZoneArea] = useState(0.25);
  const [showBasemap, setShowBasemap] = useState(true);
  const [selectedCell, setSelectedCell] = useState<number | null>(null);
  const [selectedSeasonId, setSelectedSeasonId] = useState("");
  const [selectedDateUrl, setSelectedDateUrl] = useState("");
  const [datePayload, setDatePayload] =
    useState<PerformanceDatePayload | null>(null);
  const [dateLoadStatus, setDateLoadStatus] = useState("");
  const [dayDisplay, setDayDisplay] =
    useState<SatelliteDateDisplay>("relative");

  const fieldIndex =
    performanceIndex.fields.find(
      (field) => field.fieldCode === activeFieldCode,
    ) ?? defaultField;

  useEffect(() => {
    const controller = new AbortController();
    fetch(fieldIndex.url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("performance evidence unavailable");
        return (await response.json()) as PerformancePayload;
      })
      .then((nextPayload) => {
        setPayload(nextPayload);
        const [firstYear, lastYear] = nextPayload.availableYears;
        setYearFrom(firstYear ?? DEFAULT_YEAR_FROM);
        setYearTo(lastYear ?? DEFAULT_YEAR_TO);
        setCropFilter("all");
        setComparisonMode("all-crop");
        setSelectedCell(null);
        setSelectedSeasonId(nextPayload.seasons.at(-1)?.id ?? "");
        setLoadStatus("");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadStatus(
          "Local performance evidence is unavailable. Run the performance builder.",
        );
      });
    return () => controller.abort();
  }, [fieldIndex.url]);

  useEffect(() => {
    if (viewScope !== "farm" || farmPayloads.length) return;
    const controller = new AbortController();
    Promise.all(
      performanceIndex.fields.map(async (field) => {
        const response = await fetch(field.url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`performance evidence unavailable for ${field.fieldName}`);
        }
        return (await response.json()) as PerformancePayload;
      }),
    )
      .then((nextPayloads) => {
        setFarmPayloads(nextPayloads);
        setFarmLoadStatus("");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFarmLoadStatus(
          "The whole-farm composite could not load from local field products.",
        );
      });
    return () => controller.abort();
  }, [farmPayloads.length, viewScope]);

  const isLandsatLayer =
    layer === "landsat-performance" ||
    layer === "landsat-trend" ||
    layer === "source-agreement";

  useEffect(() => {
    if (!isLandsatLayer || landsatPayloads.length) return;
    const template = performanceIndex.landsat?.fieldUrlTemplate;
    if (!template) return;
    const controller = new AbortController();
    Promise.all(
      performanceIndex.fields.map(async (field) => {
        const response = await fetch(
          template.replace("{fieldCode}", field.fieldCode),
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Landsat field product unavailable");
        return (await response.json()) as LandsatPayload;
      }),
    )
      .then((nextPayloads) => {
        setLandsatPayloads(nextPayloads);
        setLandsatLoadStatus("");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLandsatLoadStatus(
          "The native 30 m Landsat products could not be loaded locally.",
        );
      });
    return () => controller.abort();
  }, [isLandsatLayer, landsatPayloads.length]);

  const referenceCrop = useMemo(() => {
    if (!payload) return "";
    if (cropFilter !== "all" && !cropFilter.startsWith("group:")) {
      return cropFilter;
    }
    return [...payload.seasons]
      .reverse()
      .find((season) => matchesCropFilter(season, cropFilter))?.cropCode ?? "";
  }, [cropFilter, payload]);

  const filters: PerformanceFilters = useMemo(
    () => ({
      cropFilter,
      yearFrom,
      yearTo,
      comparisonMode,
      referenceCrop,
      minQuality,
      evidenceFilter,
    }),
    [
      comparisonMode,
      cropFilter,
      minQuality,
      evidenceFilter,
      referenceCrop,
      yearFrom,
      yearTo,
    ],
  );

  const filteredSeasons = useMemo(
    () => (payload ? filterPerformanceSeasons(payload.seasons, filters) : []),
    [filters, payload],
  );
  const metrics = useMemo(
    () => (payload ? calculateCellMetrics(payload, filters) : []),
    [filters, payload],
  );
  const fieldSummary = useMemo(
    () => summariseField(metrics, filteredSeasons),
    [filteredSeasons, metrics],
  );
  const fieldTrendSummary = useMemo(() => summariseTrend(metrics), [metrics]);
  const zoneClasses = useMemo(
    () =>
      payload
        ? generateManagementZones(
            metrics,
            payload.cells,
            zoneCount,
            minimumZoneArea,
          )
        : [],
    [metrics, minimumZoneArea, payload, zoneCount],
  );
  const boundaryPath = useMemo(
    () => (payload ? cellBoundaryPath(payload.cells) : ""),
    [payload],
  );
  const selectedSeason =
    filteredSeasons.find((season) => season.id === selectedSeasonId) ??
    filteredSeasons.at(-1);
  const selectedDate =
    selectedSeason?.dates.find((observation) => observation.cellUrl === selectedDateUrl) ??
    selectedSeason?.dates.at(-1);

  useEffect(() => {
    if (layer !== "date" || !selectedDate?.cellUrl) return;
    const controller = new AbortController();
    fetch(selectedDate.cellUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("individual date unavailable");
        return (await response.json()) as PerformanceDatePayload;
      })
      .then((nextPayload) => {
        setDatePayload(nextPayload);
        setDateLoadStatus("");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDateLoadStatus(
          "This individual date layer is missing. Rebuild the local performance data.",
        );
      });
    return () => controller.abort();
  }, [layer, selectedDate?.cellUrl]);

  const farmLayers = useMemo(
    () =>
      farmPayloads.map((fieldPayload) => ({
        payload: fieldPayload,
        metrics: calculateCellMetrics(fieldPayload, filters),
        seasons: filterPerformanceSeasons(fieldPayload.seasons, filters),
        boundaryPath: cellBoundaryPath(fieldPayload.cells),
      })),
    [farmPayloads, filters],
  );
  const visibleLandsatLayers = useMemo(
    () =>
      landsatPayloads
        .filter(
          (landsatPayload) =>
            viewScope === "farm" ||
            landsatPayload.field.fieldCode === activeFieldCode,
        )
        .map((landsatPayload) => ({
          payload: landsatPayload,
          metrics: calculateLandsatMetrics(landsatPayload, filters),
        })),
    [activeFieldCode, filters, landsatPayloads, viewScope],
  );
  const sentinelAgreementScores = useMemo(() => {
    const landsatGrid = performanceIndex.landsat?.grid;
    if (!landsatGrid) return new Map<string, number>();
    const sentinelLayers = (viewScope === "farm" ? farmLayers : payload
      ? [{ payload, metrics }]
      : []);
    return sentinelScoresByLandsatCell(
      sentinelLayers.map((field) => ({
        gridOffset: field.payload.gridOffset,
        cells: field.payload.cells,
        scores: field.metrics.map((metric) => metric.score),
      })),
      performanceIndex.farmGrid,
      landsatGrid,
    );
  }, [farmLayers, metrics, payload, viewScope]);
  const farmSummary = useMemo(() => {
    const allMetrics = farmLayers.flatMap((field) => field.metrics);
    const classified = allMetrics.filter((metric) => metric.score !== null);
    const weak = classified.filter((metric) => (metric.score ?? 50) < 40).length;
    const strong = classified.filter((metric) => (metric.score ?? 50) >= 60).length;
    const percent = (count: number) =>
      classified.length ? Math.round((count / classified.length) * 100) : 0;
    return {
      cells: allMetrics.length,
      classified: classified.length,
      fields: farmLayers.filter((field) =>
        field.metrics.some((metric) => metric.score !== null),
      ).length,
      seasons: farmLayers.reduce(
        (total, field) => total + field.seasons.length,
        0,
      ),
      weak: percent(weak),
      strong: percent(strong),
      average: percent(classified.length - weak - strong),
    };
  }, [farmLayers]);
  const farmTrendSummary = useMemo(
    () => summariseTrend(farmLayers.flatMap((field) => field.metrics)),
    [farmLayers],
  );
  const selectedMetric =
    selectedCell === null ? undefined : metrics[selectedCell];
  const selectedCellPosition =
    selectedCell === null || !payload ? undefined : payload.cells[selectedCell];
  const farmCropCodes = useMemo(
    () =>
      [...new Set(performanceIndex.fields.flatMap((field) => field.cropCodes))].sort(),
    [],
  );
  const farmYears = useMemo(() => {
    const available = performanceIndex.fields.flatMap((field) =>
      field.availableYears.length ? field.availableYears : [],
    );
    return available.length
      ? ([Math.min(...available), Math.max(...available)] as [number, number])
      : [];
  }, []);
  const cropCodes =
    viewScope === "farm" ? farmCropCodes : (payload?.cropCodes ?? []);
  const sentinelStart =
    viewScope === "farm" ? farmYears[0] : payload?.availableYears[0];
  const sentinelEnd =
    viewScope === "farm" ? farmYears[1] : payload?.availableYears[1];
  const sharedStart = Math.max(
    sentinelStart ?? DEFAULT_YEAR_FROM,
    performanceIndex.landsat?.availableYears[0] ?? DEFAULT_YEAR_FROM,
  );
  const sharedEnd = Math.min(
    sentinelEnd ?? DEFAULT_YEAR_TO,
    performanceIndex.landsat?.availableYears[1] ?? DEFAULT_YEAR_TO,
  );
  const availableStart =
    layer === "source-agreement"
      ? sharedStart
      : isLandsatLayer
      ? performanceIndex.landsat?.availableYears[0]
      : sentinelStart;
  const availableEnd =
    layer === "source-agreement"
      ? sharedEnd
      : isLandsatLayer
      ? performanceIndex.landsat?.availableYears[1]
      : sentinelEnd;
  const years =
    availableStart !== undefined && availableEnd !== undefined
    ? Array.from(
        {
          length: availableEnd - availableStart + 1,
        },
        (_, index) => availableStart + index,
      )
    : [];

  function selectFieldByName(name: string) {
    setFieldSearch(name);
    const field = performanceIndex.fields.find(
      (candidate) => candidate.fieldName.toLowerCase() === name.toLowerCase(),
    );
    if (field) {
      if (field.fieldCode !== activeFieldCode) {
        setPayload(null);
        setLoadStatus("Loading local field evidence…");
      }
      setActiveFieldCode(field.fieldCode);
      setViewScope("field");
    }
  }

  function showWholeFarm() {
    if (!farmPayloads.length) {
      setFarmLoadStatus("Loading all local field composites…");
    }
    setViewScope("farm");
    setDisplayMode("cells");
    setSelectedCell(null);
    if (layer === "season" || layer === "date") setLayer("performance");
  }

  function openField(fieldCode: string) {
    const field = performanceIndex.fields.find(
      (candidate) => candidate.fieldCode === fieldCode,
    );
    if (!field) return;
    if (field.fieldCode !== activeFieldCode) {
      setPayload(null);
      setLoadStatus("Loading local field evidence…");
    }
    setActiveFieldCode(field.fieldCode);
    setFieldSearch(field.fieldName);
    setViewScope("field");
    setSelectedCell(null);
  }

  function chooseLayer(nextLayer: MapLayer) {
    setLayer(nextLayer);
    setSelectedCell(null);
    if (
      nextLayer === "landsat-performance" ||
      nextLayer === "landsat-trend" ||
      nextLayer === "source-agreement"
    ) {
      const [firstYear, lastYear] = performanceIndex.landsat?.availableYears ?? [];
      if (nextLayer === "source-agreement") {
        setYearFrom(sharedStart);
        setYearTo(sharedEnd);
      } else {
        if (firstYear !== undefined) setYearFrom(firstYear);
        if (lastYear !== undefined) setYearTo(lastYear);
      }
    } else if (payload?.availableYears.length) {
      setYearFrom(payload.availableYears[0]);
      setYearTo(payload.availableYears[1]);
    }
    if (nextLayer === "date") {
      setDatePayload(null);
      setDateLoadStatus("Loading the local satellite date…");
    }
  }

  function chooseSeason(seasonId: string) {
    setSelectedSeasonId(seasonId);
    setSelectedDateUrl("");
    setDatePayload(null);
    if (layer === "date") {
      setDateLoadStatus("Loading the local satellite date…");
    }
    setSelectedCell(null);
  }

  function chooseDate(cellUrl: string) {
    setSelectedDateUrl(cellUrl);
    setDatePayload(null);
    setDateLoadStatus("Loading the local satellite date…");
    setSelectedCell(null);
  }

  function clearFilters() {
    if (availableStart === undefined || availableEnd === undefined) return;
    setCropFilter("all");
    setComparisonMode("all-crop");
    setYearFrom(availableStart);
    setYearTo(availableEnd);
    setMinQuality(60);
    setEvidenceFilter("include-limited");
    setSelectedCell(null);
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span>SPD</span>
          <div>
            <strong>Satellite Productivity Detection</strong>
            <small>Historical field performance</small>
          </div>
        </div>
        <label className={styles.fieldSearch}>
          <ControlTitle help={controlHelp.field}>Go to field</ControlTitle>
          <input
            aria-label="Go to farm field"
            list="satellite-productivity-detection-fields"
            value={fieldSearch}
            onChange={(event) => selectFieldByName(event.target.value)}
          />
          <datalist id="satellite-productivity-detection-fields">
            {performanceIndex.fields.map((field) => (
              <option key={field.fieldCode} value={field.fieldName} />
            ))}
          </datalist>
        </label>
        <a className={styles.recordsLink} href="/records">
          Crop history & evidence
        </a>
      </header>

      <main className={styles.main}>
        <section className={styles.titleRow}>
          <div>
            <span className={styles.eyebrow}>
              {ACTIVE_FARM.name} · active local farm ·{" "}
              {isLandsatLayer ? "native 30 m Landsat display" : "10 m Sentinel-2 display"}
            </span>
            <div className={styles.scopeToggle} aria-label="Map scope">
              <button
                className={viewScope === "farm" ? styles.active : ""}
                onClick={showWholeFarm}
                title="Show every mapped field on one shared north-up grid"
              >
                Whole farm
              </button>
              <button
                className={viewScope === "field" ? styles.active : ""}
                onClick={() => setViewScope("field")}
                title={`Return to the detailed map for ${fieldIndex.fieldName}`}
              >
                Selected field
              </button>
            </div>
            <h1>{viewScope === "farm" ? "Whole farm" : fieldIndex.fieldName}</h1>
            <p>
              {isLandsatLayer
                ? layer === "source-agreement"
                  ? "Independent Sentinel-2 and Landsat relative scores are compared only across their shared crop-year window after Sentinel-2 is aggregated to native 30 m cells."
                  : "Separate native 30 m Landsat evidence extends the spatial history to 2008 without being blended into the Sentinel-2 score."
                : viewScope === "farm"
                ? "Persistent performance is normalised within each field before the farm is assembled; it is not an absolute cross-field yield comparison."
                : "Multi-index satellite estimate of relative historical crop performance, not a direct yield measurement."}
            </p>
          </div>
          <div className={styles.fieldFacts}>
            {isLandsatLayer ? (
              <>
                <div>
                  <strong>{viewScope === "farm" ? performanceIndex.fieldCount : fieldIndex.recordedHectares ?? "—"}</strong>
                  <span>{viewScope === "farm" ? "mapped fields" : "hectares"}</span>
                </div>
                <div>
                  <strong>{performanceIndex.landsat?.sceneCount ?? "—"}</strong>
                  <span>Landsat source dates</span>
                </div>
                <div>
                  <strong>{visibleLandsatLayers.reduce((total, field) => total + field.payload.cells.length, 0).toLocaleString() || "—"}</strong>
                  <span>native 30 m cells shown</span>
                </div>
                <div>
                  <strong>{availableStart !== undefined && availableEnd !== undefined ? `${availableStart}–${availableEnd}` : "—"}</strong>
                  <span>{layer === "source-agreement" ? "shared sensor years" : "Landsat evidence years"}</span>
                </div>
              </>
            ) : viewScope === "farm" ? (
              <>
                <div>
                  <strong>{performanceIndex.fieldCount}</strong>
                  <span>mapped fields</span>
                </div>
                <div>
                  <strong>{farmSummary.seasons || performanceIndex.seasonCount}</strong>
                  <span>crop years used across fields</span>
                </div>
                <div>
                  <strong>{farmSummary.cells.toLocaleString() || "—"}</strong>
                  <span>retained 10 m cells</span>
                </div>
                <div>
                  <strong>{performanceIndex.individualDateCount.toLocaleString()}</strong>
                  <span>source field-date images</span>
                </div>
              </>
            ) : (
              <>
                <div>
                  <strong>{fieldIndex.recordedHectares ?? "—"}</strong>
                  <span>hectares</span>
                </div>
                <div>
                  <strong>{fieldSummary.seasons}</strong>
                  <span>crop years used</span>
                </div>
                <div>
                  <strong>
                    {fieldSummary.years
                      ? `${fieldSummary.years[0]}–${fieldSummary.years[1]}`
                      : "—"}
                  </strong>
                  <span>evidence years</span>
                </div>
                <div>
                  <strong>{fieldSummary.medianObservations}</strong>
                  <span>median source dates / cell</span>
                </div>
              </>
            )}
          </div>
        </section>

        {(performanceIndex.sceneErrorCount ?? 0) > 0 && (
          <div className={styles.warningList} role="status">
            <p>
              {performanceIndex.sceneErrorCount} Sentinel-2 scene
              {performanceIndex.sceneErrorCount === 1 ? "" : "s"} failed during
              the last optical ingest. Those dates were excluded; inspect the
              local performance summary before relying on affected crop years.
            </p>
          </div>
        )}

        <section className={styles.controls} aria-label="Analysis controls">
          <label>
            <ControlTitle help={controlHelp.layer}>
              What the map shows
            </ControlTitle>
            <select
              aria-label="What the map shows"
              value={layer}
              onChange={(event) =>
                chooseLayer(event.target.value as MapLayer)
              }
            >
              {Object.entries(layerLabels)
                .filter(
                  ([value]) =>
                    value !== "confidence" &&
                    (viewScope === "field" ||
                      (value !== "season" && value !== "date")),
                )
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <ControlTitle help={controlHelp.crop}>
              Crops included
            </ControlTitle>
            <select
              aria-label="Crops included"
              value={cropFilter}
              onChange={(event) => {
                setCropFilter(event.target.value);
                setSelectedCell(null);
              }}
            >
              <option value="all">All crops</option>
              <optgroup label="Crop groups">
                <option value="group:cereal">All cereals</option>
                <option value="group:break">All break crops</option>
                <option value="group:grass">All grass</option>
              </optgroup>
              <optgroup label="Individual crops">
                {cropCodes.map((crop) => (
                  <option key={crop} value={crop}>
                    {cropLabel(crop)}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            <ControlTitle help={controlHelp.comparison}>
              Comparison method
            </ControlTitle>
            <select
              aria-label="Comparison method"
              value={comparisonMode}
              onChange={(event) =>
                setComparisonMode(event.target.value as ComparisonMode)
              }
            >
              <option value="all-crop">Across all selected crops</option>
              <option value="same-crop">
                Only {cropLabel(referenceCrop || "latest crop")}
              </option>
            </select>
          </label>
          <div className={styles.yearControl}>
            <ControlTitle help={controlHelp.years}>
              Crop years included
            </ControlTitle>
            <div>
              <select
                aria-label="First crop harvest year"
                value={yearFrom}
                onChange={(event) =>
                  setYearFrom(Math.min(Number(event.target.value), yearTo))
                }
              >
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
              <i>to</i>
              <select
                aria-label="Last crop harvest year"
                value={yearTo}
                onChange={(event) =>
                  setYearTo(Math.max(Number(event.target.value), yearFrom))
                }
              >
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {(!isLandsatLayer || layer === "source-agreement") && <label>
            <ControlTitle help={controlHelp.quality}>
              Minimum season quality
            </ControlTitle>
            <select
              aria-label="Minimum season data quality"
              value={minQuality}
              onChange={(event) => setMinQuality(Number(event.target.value))}
            >
              <option value="0">Any quality</option>
              <option value="50">50%</option>
              <option value="60">60%</option>
              <option value="70">70%</option>
              <option value="80">80%</option>
            </select>
          </label>}
          {(!isLandsatLayer || layer === "source-agreement") && <label>
            <ControlTitle help={controlHelp.evidenceTier}>
              Seasonal evidence coverage
            </ControlTitle>
            <select
              aria-label="Seasonal evidence coverage"
              value={evidenceFilter}
              onChange={(event) =>
                setEvidenceFilter(event.target.value as SeasonEvidenceFilter)
              }
            >
              <option value="include-limited">
                Full + limited seasons (confidence-adjusted)
              </option>
              <option value="full-only">
                Fully bracketed single-season trajectories only
              </option>
            </select>
          </label>}
          <button className={styles.clearButton} onClick={clearFilters}>
            Reset filters
          </button>
        </section>

        {viewScope === "field" &&
          (layer === "season" || layer === "date") &&
          filteredSeasons.length > 0 && (
          <div className={styles.evidenceControls}>
            <label>
              <ControlTitle help={controlHelp.cropYear}>
                Crop-year composite
              </ControlTitle>
              <select
                aria-label="Crop-year composite shown"
                value={selectedSeason?.id ?? ""}
                onChange={(event) => chooseSeason(event.target.value)}
              >
                {[...filteredSeasons].reverse().map((season) => (
                  <option key={season.id} value={season.id}>
                    {season.harvestYear} · {cropLabel(season.cropCode)} ·{" "}
                    {season.dates.length} dates ·{" "}
                    {(season.evidenceTier ?? "full-season") === "full-season"
                      ? "full trajectory"
                      : season.evidenceTier === "grass-seasonal"
                        ? "grass seasonal"
                        : "partial season"}
                  </option>
                ))}
              </select>
            </label>
            {layer === "date" && selectedSeason && (
              <>
                <span className={styles.evidenceArrow}>→</span>
                <label>
                  <ControlTitle help={controlHelp.satelliteDate}>
                    Source satellite date
                  </ControlTitle>
                  <select
                    aria-label="Source satellite date"
                    value={selectedDate?.cellUrl ?? ""}
                    onChange={(event) => chooseDate(event.target.value)}
                  >
                    {[...selectedSeason.dates].reverse().map((observation) => (
                      <option
                        key={observation.cellUrl}
                        value={observation.cellUrl}
                      >
                        {observation.date} · {observation.stage} ·{" "}
                        {Math.round(observation.clearFraction * 100)}% clear
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <ControlTitle help={controlHelp.dateValue}>
                    Value shown
                  </ControlTitle>
                  <select
                    aria-label="Value shown for satellite date"
                    value={dayDisplay}
                    onChange={(event) =>
                      setDayDisplay(event.target.value as SatelliteDateDisplay)
                    }
                  >
                    <option value="relative">
                      Composite input · equal multi-index relative position
                    </option>
                    <optgroup label="Vegetation and water indices">
                      {(["ndvi", "evi2", "ndre", "ndwi"] as SatelliteFeature[]).map(
                        (feature) => (
                          <option key={feature} value={feature}>
                            {satelliteFeatureLabels[feature]} · native{" "}
                            {satelliteFeatureSupport[feature]} m
                          </option>
                        ),
                      )}
                    </optgroup>
                    <optgroup label="Individual Sentinel-2 bands">
                      {satelliteFeatures
                        .filter(
                          (feature) =>
                            !["ndvi", "evi2", "ndre", "ndwi"].includes(feature),
                        )
                        .map((feature) => (
                          <option key={feature} value={feature}>
                            {satelliteFeatureLabels[feature]} · native 20 m
                          </option>
                        ))}
                    </optgroup>
                  </select>
                </label>
              </>
            )}
            <p className={styles.evidenceBreadcrumb}>
              Historical composite → {selectedSeason?.harvestYear}{" "}
              {cropLabel(selectedSeason?.cropCode ?? "")}
              {layer === "date" && selectedDate
                ? ` → ${selectedDate.date} (${selectedDate.stage}, ${Math.round(
                    selectedDate.clearFraction * 100,
                  )}% clear, weight ${selectedDate.observationWeight.toFixed(2)})`
                : " crop-year composite"}
            </p>
          </div>
        )}

        <section className={styles.mapWorkspace}>
          <div className={styles.mapColumn}>
            <div className={styles.mapTools}>
              <div className={styles.mapModeControl}>
                <ControlTitle help={controlHelp.mapDetail}>
                  {isLandsatLayer ? "Map support" : "Map detail"}
                </ControlTitle>
                <div className={styles.segmented}>
                  <button
                    className={displayMode === "cells" ? styles.active : ""}
                    onClick={() => setDisplayMode("cells")}
                  >
                    {isLandsatLayer ? "Native 30 m cells" : "Individual 10 m cells"}
                  </button>
                  <button
                    className={displayMode === "zones" ? styles.active : ""}
                    disabled={isLandsatLayer || viewScope === "farm" || layer !== "performance"}
                    onClick={() => setDisplayMode("zones")}
                    title={
                      viewScope === "farm"
                        ? "Open one field before creating management zones"
                        : layer !== "performance"
                          ? "Management zones are available for long-term relative performance"
                          : "Group neighbouring cells into broader management zones"
                    }
                  >
                    Management zones
                  </button>
                </div>
              </div>
              {viewScope === "field" &&
                displayMode === "zones" &&
                layer === "performance" && (
                <>
                  <label>
                    <ControlTitle help={controlHelp.zoneClasses}>
                      Zone classes
                    </ControlTitle>
                    <select
                      aria-label="Number of management zones"
                      value={zoneCount}
                      onChange={(event) =>
                        setZoneCount(Number(event.target.value) as 3 | 4 | 5)
                      }
                    >
                      <option value="3">3</option>
                      <option value="4">4</option>
                      <option value="5">5</option>
                    </select>
                  </label>
                  <label>
                    <ControlTitle help={controlHelp.minimumZone}>
                      Smallest zone
                    </ControlTitle>
                    <select
                      aria-label="Minimum zone area"
                      value={minimumZoneArea}
                      onChange={(event) =>
                        setMinimumZoneArea(Number(event.target.value))
                      }
                    >
                      <option value="0.1">0.10 ha</option>
                      <option value="0.25">0.25 ha</option>
                      <option value="0.5">0.50 ha</option>
                    </select>
                  </label>
                </>
              )}
              <button
                className={styles.basemapButton}
                aria-label="Toggle basemap grid"
                aria-pressed={showBasemap}
                onClick={() => setShowBasemap((value) => !value)}
                title="Show or hide the neutral 50 m reference grid behind the field"
              >
                {showBasemap ? "Reference grid: on" : "Reference grid: off"}
              </button>
            </div>

            <div
              className={`${styles.mapFrame} ${
                showBasemap ? styles.withBasemap : ""
              }`}
            >
              {isLandsatLayer ? (
                visibleLandsatLayers.length ? (
                  <LandsatMap
                    layer={layer as "landsat-performance" | "landsat-trend" | "source-agreement"}
                    layers={visibleLandsatLayers}
                    onOpenField={openField}
                    scope={viewScope}
                    sentinelScores={sentinelAgreementScores}
                    showBasemap={showBasemap}
                  />
                ) : (
                  <div className={styles.mapStatus}>
                    {landsatLoadStatus || "Loading native 30 m Landsat evidence…"}
                  </div>
                )
              ) : viewScope === "farm" ? (
                farmPayloads.length ? (
                  <FarmCompositeMap
                    dayDisplay={dayDisplay}
                    farmLayers={farmLayers}
                    layer={layer}
                    onOpenField={openField}
                    showBasemap={showBasemap}
                  />
                ) : (
                  <div className={styles.mapStatus}>
                    {farmLoadStatus || "Loading all local field composites…"}
                  </div>
                )
              ) : payload && (layer !== "date" || datePayload) ? (
                <svg
                  aria-label={`${layerLabels[layer]} map for ${payload.fieldName}`}
                  className={styles.performanceMap}
                  viewBox={`-2 -2 ${payload.width + 4} ${payload.height + 4}`}
                  preserveAspectRatio="xMidYMid meet"
                >
                  <defs>
                    <pattern
                      id="map-grid"
                      width="5"
                      height="5"
                      patternUnits="userSpaceOnUse"
                    >
                      <path
                        d="M 5 0 L 0 0 0 5"
                        fill="none"
                        stroke="#83948d"
                        strokeWidth="0.07"
                        opacity="0.32"
                      />
                    </pattern>
                    <pattern
                      id="low-confidence-hatch"
                      width="2"
                      height="2"
                      patternUnits="userSpaceOnUse"
                    >
                      <path
                        d="M-0.5 0.5 L0.5 -0.5 M0 2 L2 0 M1.5 2.5 L2.5 1.5"
                        stroke="#ffffff"
                        strokeWidth="0.16"
                        opacity="0.55"
                      />
                    </pattern>
                    <pattern
                      id="insufficient-hatch"
                      width="2"
                      height="2"
                      patternUnits="userSpaceOnUse"
                    >
                      <rect width="2" height="2" fill="#a9afaa" />
                      <path
                        d="M-0.5 0.5 L0.5 -0.5 M0 2 L2 0 M1.5 2.5 L2.5 1.5"
                        stroke="#777f7a"
                        strokeWidth="0.18"
                      />
                    </pattern>
                  </defs>
                  {showBasemap && (
                    <rect
                      x="-2"
                      y="-2"
                      width={payload.width + 4}
                      height={payload.height + 4}
                      fill="url(#map-grid)"
                    />
                  )}
                  <g className={styles.cells}>
                    {payload.cells.map(([column, row], index) => {
                      const metric = metrics[index];
                      const rawValue = layerValue(
                        layer,
                        metric,
                        selectedSeason,
                        datePayload,
                        dayDisplay,
                        index,
                      );
                      const zoneValue =
                        displayMode === "zones" &&
                        layer === "performance" &&
                        zoneClasses[index] !== null
                          ? ((zoneClasses[index] ?? 0) + 0.5) *
                            (100 / zoneCount)
                          : rawValue;
                      const insufficient =
                        rawValue === null ||
                        ((layer !== "season" && layer !== "date") &&
                          metric.seasonCount < 2);
                      const fill = insufficient
                        ? "url(#insufficient-hatch)"
                        : layerColour(layer, zoneValue, dayDisplay);
                      const selected = selectedCell === index;
                      return (
                        <g key={`${column}:${row}`}>
                          <rect
                            aria-label={`Cell ${column + 1}, ${row + 1}: ${formatLayerValue(layer, rawValue, dayDisplay)}`}
                            className={selected ? styles.selectedCell : ""}
                            fill={fill}
                            height="1.02"
                            onClick={() => setSelectedCell(index)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                setSelectedCell(index);
                              }
                            }}
                            role="button"
                            tabIndex={0}
                            width="1.02"
                            x={column}
                            y={row}
                          >
                            <title>
                              {formatLayerValue(layer, rawValue, dayDisplay)} ·{" "}
                              {metric.confidence}% confidence ·{" "}
                              {metric.seasonCount} seasons
                            </title>
                          </rect>
                          {!insufficient &&
                            (layer === "performance" || layer === "trend") &&
                            metric.confidence < 45 && (
                              <rect
                                fill="url(#low-confidence-hatch)"
                                height="1.02"
                                pointerEvents="none"
                                width="1.02"
                                x={column}
                                y={row}
                              />
                            )}
                        </g>
                      );
                    })}
                  </g>
                  <path
                    className={styles.fieldBoundary}
                    d={boundaryPath}
                    pointerEvents="none"
                  />
                  <g className={styles.northArrow}>
                    <path d="M1 4V1.4M1 1.4L0.65 2M1 1.4L1.35 2" />
                    <text x="1" y="0.9">
                      N
                    </text>
                  </g>
                  <g className={styles.scaleBar}>
                    <line
                      x1="1"
                      x2="6"
                      y1={payload.height + 1}
                      y2={payload.height + 1}
                    />
                    <text x="3.5" y={payload.height + 1.75}>
                      50 m
                    </text>
                  </g>
                </svg>
              ) : (
                <div className={styles.mapStatus}>
                  {layer === "date" ? dateLoadStatus : loadStatus}
                </div>
              )}
            </div>

            <div
              className={styles.legend}
              aria-label={`${layerLabels[layer]} legend`}
            >
              <div className={styles.legendHeading}>
                <strong>{legendHeading(layer, dayDisplay)}</strong>
                <HelpTip text={legendExplanation(layer, dayDisplay)} />
              </div>
              <div className={styles.legendItems}>
                {legendFor(layer, dayDisplay).map(([colour, label]) => (
                  <span key={label}>
                    <i style={{ background: colour }} />
                    {label}
                  </span>
                ))}
              </div>
              {(layer === "performance" || layer === "trend") && (
                <small>
                  Diagonal lines mark lower-confidence cells. Grey diagonal
                  lines mean there is not enough evidence.
                </small>
              )}
            </div>
          </div>

          <aside className={styles.inspector}>
            {isLandsatLayer ? (
              <div className={styles.fieldSummary}>
                <div className={styles.inspectorKicker}>
                  <span>Separate Landsat evidence track</span>
                  <span>native 30 m</span>
                </div>
                <h2>
                  {layer === "source-agreement"
                    ? "Where two independent sensors agree"
                    : layer === "landsat-trend"
                      ? "Long-history relative change"
                      : "Long-history relative position"}
                </h2>
                <p>
                  {layer === "source-agreement"
                    ? "Sentinel-2 has been aggregated to Landsat cells for this comparison. Close agreement strengthens evidence of a persistent spatial pattern; disagreement is retained for investigation."
                    : "These scores use Landsat NDVI, EVI2 and NDWI at native 30 m support. They are filtered by crop and harvest year but are not mixed into the Sentinel-2 composite."}
                </p>
                <div className={styles.warningList}>
                  <p>
                    Crop years 2010 and 2012 remain sparse in the local archive.
                    Individual cells require two seasons for persistence and
                    three seasons spanning two years for a trend.
                  </p>
                </div>
              </div>
            ) : viewScope === "farm" ? (
              <div className={styles.fieldSummary}>
                <div className={styles.inspectorKicker}>
                  <span>Farm composite</span>
                  <span>
                    {farmSummary.fields || performanceIndex.fieldCount} fields
                  </span>
                </div>
                <h2>
                  {layer === "trend"
                    ? "Where relative performance is changing most"
                    : "Click any field to inspect its source imagery"}
                </h2>
                <p>
                  {layer === "trend"
                    ? "Teal cells have gained position relative to the rest of their own field; red cells have lost position. Click a field, then a cell, to inspect its crop-year sequence."
                    : "The farm view preserves the position of every real 10 m Sentinel cell. Each field is scored relative to itself before the fields are assembled on one north-up grid."}
                </p>
                <div className={styles.summaryBlock}>
                  <span>
                    {layer === "trend"
                      ? "Farm area with an estimable trend"
                      : "Whole-farm relative area"}
                  </span>
                  <div className={styles.stackedBar}>
                    <i
                      className={styles.weakArea}
                      style={{
                        width: `${
                          layer === "trend"
                            ? farmTrendSummary.worsening
                            : farmSummary.weak
                        }%`,
                      }}
                    />
                    <i
                      className={styles.averageArea}
                      style={{
                        width: `${
                          layer === "trend"
                            ? farmTrendSummary.stable
                            : farmSummary.average
                        }%`,
                      }}
                    />
                    <i
                      className={styles.strongArea}
                      style={{
                        width: `${
                          layer === "trend"
                            ? farmTrendSummary.improving
                            : farmSummary.strong
                        }%`,
                      }}
                    />
                  </div>
                  <p>
                    {layer === "trend" ? (
                      <>
                        {farmTrendSummary.worsening}% worsening ·{" "}
                        {farmTrendSummary.stable}% broadly stable ·{" "}
                        {farmTrendSummary.improving}% improving
                      </>
                    ) : (
                      <>
                        {farmSummary.weak}% weak · {farmSummary.average}% average ·{" "}
                        {farmSummary.strong}% strong
                      </>
                    )}
                  </p>
                </div>
                <div className={styles.summaryBlock}>
                  <span>Evidence currently included</span>
                  <p>
                    {(layer === "trend"
                      ? farmTrendSummary.classified
                      : farmSummary.classified
                    ).toLocaleString()} classified cells ·{" "}
                    {farmSummary.seasons} crop years used across the mapped fields
                  </p>
                </div>
                <div className={styles.farmDisclosure}>
                  {layer === "trend"
                    ? "This is a descriptive relative trend, not an absolute yield trend. Crop sequence and weather may contribute; use the crop and year filters for like-for-like checks."
                    : "Relative colour does not mean that a green cell in one field has higher absolute vegetation-index values or yield than a green cell in another. Active crop, year and quality filters are applied field by field."}
                </div>
              </div>
            ) : selectedMetric && selectedCellPosition ? (
              <CellEvidence
                cell={selectedCellPosition}
                cellIndex={selectedCell ?? 0}
                dayDisplay={dayDisplay}
                layer={layer}
                metric={selectedMetric}
                selectedDate={layer === "date" ? selectedDate : undefined}
                selectedDatePayload={
                  layer === "date" ? datePayload : undefined
                }
                selectedSeason={
                  layer === "season" || layer === "date"
                    ? selectedSeason
                    : undefined
                }
              />
            ) : (
              <div className={styles.fieldSummary}>
                <div className={styles.inspectorKicker}>
                  <span>Field summary</span>
                  <span>
                    {layer === "trend"
                      ? fieldTrendSummary.classified
                      : fieldSummary.classifiedCells} classified cells
                  </span>
                </div>
                <h2>
                  {layer === "trend"
                    ? "Click a changing cell to inspect its sequence"
                    : "Click a cell to inspect its evidence"}
                </h2>
                <p>
                  {layer === "trend"
                    ? "The trend uses crop-season relative scores, not raw vegetation-index values. The inspector shows every crop year contributing to the slope."
                    : "Each square is one real Sentinel-2 grid cell. Evidence confidence is reported here and by hatching on the performance map; it is not presented as a separate spatial surface."}
                </p>
                <div className={styles.summaryBlock}>
                  <span>Confidence coverage</span>
                  <div className={styles.stackedBar}>
                    <i
                      className={styles.highConfidence}
                      style={{ width: `${fieldSummary.confidence.high}%` }}
                    />
                    <i
                      className={styles.mediumConfidence}
                      style={{ width: `${fieldSummary.confidence.medium}%` }}
                    />
                    <i
                      className={styles.lowConfidence}
                      style={{ width: `${fieldSummary.confidence.low}%` }}
                    />
                  </div>
                  <p>
                    {fieldSummary.confidence.high}% high ·{" "}
                    {fieldSummary.confidence.medium}% medium ·{" "}
                    {fieldSummary.confidence.low}% low
                  </p>
                </div>
                <div className={styles.summaryBlock}>
                  <span>
                    {layer === "trend"
                      ? "Area with an estimable trend"
                      : "Relative field area"}
                  </span>
                  <div className={styles.stackedBar}>
                    <i
                      className={styles.weakArea}
                      style={{
                        width: `${
                          layer === "trend"
                            ? fieldTrendSummary.worsening
                            : fieldSummary.performance.weak
                        }%`,
                      }}
                    />
                    <i
                      className={styles.averageArea}
                      style={{
                        width: `${
                          layer === "trend"
                            ? fieldTrendSummary.stable
                            : fieldSummary.performance.average
                        }%`,
                      }}
                    />
                    <i
                      className={styles.strongArea}
                      style={{
                        width: `${
                          layer === "trend"
                            ? fieldTrendSummary.improving
                            : fieldSummary.performance.strong
                        }%`,
                      }}
                    />
                  </div>
                  <p>
                    {layer === "trend" ? (
                      <>
                        {fieldTrendSummary.worsening}% worsening ·{" "}
                        {fieldTrendSummary.stable}% broadly stable ·{" "}
                        {fieldTrendSummary.improving}% improving
                      </>
                    ) : (
                      <>
                        {fieldSummary.performance.weak}% weak ·{" "}
                        {fieldSummary.performance.average}% average ·{" "}
                        {fieldSummary.performance.strong}% strong
                      </>
                    )}
                  </p>
                </div>
                <div className={styles.warningList}>
                  {(payload?.excludedSeasons?.length ?? 0) > 0 && (
                    <p>
                      {payload?.excludedSeasons?.length} crop year
                      {payload?.excludedSeasons?.length === 1 ? " was" : "s were"}{" "}
                      excluded because fewer than four adequate clear dates were
                      available, or grass coverage spanned fewer than 90 days.
                    </p>
                  )}
                  {fieldSummary.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </section>

        {viewScope === "field" && (
        <section className={styles.secondary} aria-label="Supporting evidence">
          <details open>
            <summary>Method & evidence</summary>
            <div className={styles.drawerContent}>
              <div>
                <span className={styles.miniLabel}>Persistent score</span>
                <p>
                  NDVI, EVI2, NDRE and NDWI are separately ranked from 0–100
                  within each field-date and equally averaged where available.
                  Dates are weighted by clear coverage, feature support and
                  trajectory-derived crop stage, then combined within each crop
                  season. Crop-window and boundary confidence weight completed
                  seasons, where those factors do not cancel mathematically.
                </p>
              </div>
              <div>
                <span className={styles.miniLabel}>Confidence</span>
                <p>
                  Confidence uses four inspectable components: effective season
                  depth, data quality, crop breadth and weather breadth. Crop/year
                  dominance and any provisional historical boundary are explicit
                  penalties; edge distance is not portrayed as a separate
                  uncertainty signal.
                </p>
              </div>
              <div>
                <span className={styles.miniLabel}>Relative change over time</span>
                <p>
                  The median slope across every pair of usable crop-season
                  scores estimates percentile-point change per year. Three
                  independent seasons spanning at least two years are required;
                  crop and weather effects remain possible explanations.
                </p>
              </div>
              <div>
                <span className={styles.miniLabel}>Guardrails</span>
                <p>
                  Satellite indices are not yield. The 20 m red-edge and SWIR
                  signal is never treated as 10 m evidence, weather has no
                  artificial within-field variation, inferred stages are
                  labelled estimates, and causes require field evidence.
                </p>
              </div>
              <div>
                <span className={styles.miniLabel}>Cloud-resistant radar</span>
                <p>
                  {performanceIndex.radar?.status === "available"
                    ? `${performanceIndex.radar.sceneCount} terrain-corrected Sentinel-1 scenes are available as supplementary 30 m evidence. They are not silently mixed into the optical score.`
                    : "Sentinel-1 support is ready for terrain-corrected OPERA RTC inputs, but no radar scenes are currently ingested. Raw GRD digital numbers are rejected."}
                </p>
              </div>
              <div>
                <span className={styles.miniLabel}>Longer historical record</span>
                <p>
                  {performanceIndex.landsat?.status === "available"
                    ? `${performanceIndex.landsat.sceneCount} Landsat observations from ${performanceIndex.landsat.availableYears.join("–")} are available as a separate 30 m evidence track. They are not mixed into the Sentinel-2 score.`
                    : "The separate 30 m Landsat history has not yet been ingested. It will extend the time record without claiming 10 m detail or red-edge measurements."}
                </p>
              </div>
            </div>
          </details>
          <details>
            <summary>Estimated crop-stage trajectories</summary>
            <div className={styles.drawerTable}>
              <table>
                <thead>
                  <tr>
                    <th>Harvest</th>
                    <th>Crop</th>
                    <th>Green-up</th>
                    <th>Peak canopy</th>
                    <th>Senescence</th>
                    <th>High canopy</th>
                    <th>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(payload?.seasons ?? [])].reverse().map((season) => (
                    <tr key={season.id}>
                      <td>{season.harvestYear}</td>
                      <td>{cropLabel(season.cropCode)}</td>
                      <td>{season.phenology?.greenupDate ?? "Not resolved"}</td>
                      <td>{season.phenology?.peakCanopyDate ?? "Not resolved"}</td>
                      <td>
                        {season.phenology?.senescenceOnsetDate ?? "Not resolved"}
                      </td>
                      <td>
                        {season.phenology?.highCanopyDurationDays === undefined
                          ? "—"
                          : `${season.phenology.highCanopyDurationDays} days`}
                      </td>
                      <td>{season.phenology?.confidence ?? 0}% · estimated</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <details>
            <summary>Crop history</summary>
            <div className={styles.drawerTable}>
              <table>
                <thead>
                  <tr>
                    <th>Harvest</th>
                    <th>Crop</th>
                    <th>Window</th>
                    <th>Dates</th>
                    <th>Quality</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(payload?.seasons ?? [])].reverse().map((season) => (
                    <tr key={season.id}>
                      <td>{season.harvestYear}</td>
                      <td>{cropLabel(season.cropCode)}</td>
                      <td>
                        {season.windowStart}–{season.windowEnd}
                      </td>
                      <td>{season.dates.length}</td>
                      <td>{season.dataQuality}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <details>
            <summary>Weather history</summary>
            <div className={styles.drawerTable}>
              <table>
                <thead>
                  <tr>
                    <th>Harvest</th>
                    <th>Crop</th>
                    <th>Class</th>
                    <th>Water balance</th>
                    <th>Thermal time</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(payload?.seasons ?? [])].reverse().map((season) => (
                    <tr key={season.id}>
                      <td>{season.harvestYear}</td>
                      <td>{cropLabel(season.cropCode)}</td>
                      <td>
                        <WeatherBadge value={season.weatherClass} />
                      </td>
                      <td>
                        {season.waterBalanceMm === null
                          ? "Incomplete"
                          : `${season.waterBalanceMm > 0 ? "+" : ""}${season.waterBalanceMm.toFixed(0)} mm`}
                      </td>
                      <td>
                        {season.gddBase5 === null
                          ? "—"
                          : `${season.gddBase5.toFixed(0)} GDD₅`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <details>
            <summary>Data quality & edit records</summary>
            <div className={styles.drawerContent}>
              <div>
                <span className={styles.miniLabel}>Current evidence</span>
                <p>
                  {fieldSummary.seasons} crop years pass the active filters;
                  {fieldSummary.classifiedCells} of {fieldSummary.cells} retained
                  10 m cells have at least two independent crop years.
                </p>
              </div>
              <div>
                <span className={styles.miniLabel}>Local records</span>
                <p>
                  Crop history editing, import checks and the full weather notes
                  remain available on the secondary records page.
                </p>
                <a className={styles.drawerLink} href="/records">
                  Review or edit crop records →
                </a>
              </div>
            </div>
          </details>
        </section>
        )}
      </main>
    </div>
  );
}
