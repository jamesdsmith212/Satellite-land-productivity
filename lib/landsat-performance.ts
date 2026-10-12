import type { PerformanceFilters } from "./performance";

export interface LandsatCell {
  id: number;
  row: number;
  column: number;
}

export interface LandsatSeason {
  id: string;
  harvestYear: number;
  crop: string;
  observationCount: number;
  modelEligible: boolean;
  compositeScores: Array<number | null>;
}

export interface LandsatPayload {
  field: {
    fieldCode: string;
    fieldName: string;
    recordedHectares: number | null;
  };
  nativeSupportMetres: 30;
  cells: LandsatCell[];
  seasons: LandsatSeason[];
}

export interface LandsatCellMetrics {
  score: number | null;
  trendPerYear: number | null;
  seasonCount: number;
  years: number[];
  crops: string[];
}

export interface GridDefinition {
  width: number;
  height: number;
  geotransform: [number, number, number, number, number, number];
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function cropGroup(crop: string) {
  if (crop.endsWith("wheat") || crop.endsWith("barley") || crop.endsWith("oats")) {
    return "cereal";
  }
  if (crop.endsWith("beans") || crop.endsWith("oilseed_rape")) return "break";
  if (crop === "grass") return "grass";
  return "other";
}

export function filterLandsatSeasons(
  seasons: LandsatSeason[],
  filters: PerformanceFilters,
) {
  const sameCrop =
    filters.comparisonMode === "same-crop"
      ? filters.referenceCrop ||
        (filters.cropFilter === "all" || filters.cropFilter.startsWith("group:")
          ? ""
          : filters.cropFilter)
      : "";
  return seasons.filter((season) => {
    const cropMatches =
      filters.cropFilter === "all" ||
      (filters.cropFilter.startsWith("group:")
        ? cropGroup(season.crop) === filters.cropFilter.slice(6)
        : season.crop === filters.cropFilter);
    return (
      season.modelEligible &&
      season.harvestYear >= filters.yearFrom &&
      season.harvestYear <= filters.yearTo &&
      cropMatches &&
      (!sameCrop || season.crop === sameCrop)
    );
  });
}

export function calculateLandsatMetrics(
  payload: LandsatPayload,
  filters: PerformanceFilters,
) {
  const seasons = filterLandsatSeasons(payload.seasons, filters);
  return payload.cells.map((_, cellIndex): LandsatCellMetrics => {
    const evidence = seasons
      .map((season) => ({
        year: season.harvestYear,
        crop: season.crop,
        score: season.compositeScores[cellIndex],
      }))
      .filter(
        (row): row is { year: number; crop: string; score: number } =>
          row.score !== null,
      );
    const score = evidence.length >= 2
      ? evidence.reduce((total, row) => total + row.score, 0) / evidence.length
      : null;
    const byYear = new Map<number, number[]>();
    for (const row of evidence) {
      byYear.set(row.year, [...(byYear.get(row.year) ?? []), row.score]);
    }
    const points = [...byYear.entries()]
      .map(([year, values]) => ({
        year,
        score: values.reduce((total, value) => total + value, 0) / values.length,
      }))
      .sort((left, right) => left.year - right.year);
    const slopes: number[] = [];
    if (points.length >= 3 && points.at(-1)!.year - points[0].year >= 2) {
      for (let earlier = 0; earlier < points.length - 1; earlier += 1) {
        for (let later = earlier + 1; later < points.length; later += 1) {
          slopes.push(
            (points[later].score - points[earlier].score) /
              (points[later].year - points[earlier].year),
          );
        }
      }
    }
    return {
      score: score === null ? null : Math.round(score * 10) / 10,
      trendPerYear: slopes.length ? Math.round(median(slopes) * 10) / 10 : null,
      seasonCount: evidence.length,
      years: [...new Set(evidence.map((row) => row.year))].sort(),
      crops: [...new Set(evidence.map((row) => row.crop))].sort(),
    };
  });
}

export function sentinelScoresByLandsatCell(
  sentinelFields: Array<{
    gridOffset: [number, number];
    cells: Array<[number, number, number]>;
    scores: Array<number | null>;
  }>,
  sentinelGrid: GridDefinition,
  landsatGrid: GridDefinition,
) {
  const grouped = new Map<string, number[]>();
  for (const field of sentinelFields) {
    field.cells.forEach(([column, row], index) => {
      const score = field.scores[index];
      if (score === null) return;
      const globalColumn = column + field.gridOffset[0];
      const globalRow = row + field.gridOffset[1];
      const x = sentinelGrid.geotransform[0] +
        (globalColumn + 0.5) * sentinelGrid.geotransform[1];
      const y = sentinelGrid.geotransform[3] +
        (globalRow + 0.5) * sentinelGrid.geotransform[5];
      const landsatColumn = Math.floor(
        (x - landsatGrid.geotransform[0]) / landsatGrid.geotransform[1],
      );
      const landsatRow = Math.floor(
        (y - landsatGrid.geotransform[3]) / landsatGrid.geotransform[5],
      );
      if (
        landsatColumn < 0 ||
        landsatRow < 0 ||
        landsatColumn >= landsatGrid.width ||
        landsatRow >= landsatGrid.height
      ) return;
      const key = `${landsatRow}:${landsatColumn}`;
      grouped.set(key, [...(grouped.get(key) ?? []), score]);
    });
  }
  return new Map(
    [...grouped.entries()].map(([key, values]) => [
      key,
      values.reduce((total, value) => total + value, 0) / values.length,
    ]),
  );
}

export function sourceAgreement(
  landsatScore: number | null,
  sentinelScore: number | undefined,
) {
  if (landsatScore === null || sentinelScore === undefined) return null;
  return Math.max(0, Math.round((100 - Math.abs(landsatScore - sentinelScore)) * 10) / 10);
}
