export type WeatherClass = "wet" | "dry" | "typical" | "unknown";
export type WeatherEvidenceLevel =
  | "none"
  | "observed-once"
  | "repeated-indication"
  | "supported-sensitivity";
export type ComparisonMode = "all-crop" | "same-crop";
export type SeasonEvidenceFilter = "include-limited" | "full-only";
export type SeasonEvidenceTier =
  | "full-season"
  | "partial-season"
  | "grass-seasonal";
export type SatelliteFeature =
  | "ndvi"
  | "evi2"
  | "ndre"
  | "ndwi"
  | "rededge1"
  | "rededge2"
  | "rededge3"
  | "nir08"
  | "swir16"
  | "swir22";
export type SatelliteDateDisplay = "relative" | SatelliteFeature;

export interface PerformanceDate {
  date: string;
  stage: string;
  stageEstimated: boolean;
  stageMethod: string;
  trajectoryValue: number | null;
  relativeSeasonPosition: number;
  gddBase5FromWindowStart: number | null;
  medianNdvi: number | null;
  medianEvi2: number | null;
  medianNdre: number | null;
  medianNdwi: number | null;
  featureMedians: Partial<Record<SatelliteFeature, number | null>>;
  clearFraction: number;
  native20mClearFraction: number | null;
  relativeFeatureCount: number;
  stageWeight: number;
  observationWeight: number;
  cellUrl: string;
}

export interface PerformanceDatePayload {
  fieldCode: string;
  fieldName: string;
  seasonId: string;
  harvestYear: number;
  cropCode: string;
  date: string;
  sceneId: string;
  pixelSizeMetres: number;
  displayPixelSizeMetres: number;
  nativeSupportMetres: Record<SatelliteFeature, number>;
  displayResampling: Partial<Record<SatelliteFeature, string>>;
  width: number;
  height: number;
  features: Record<SatelliteFeature, Array<number | null>>;
  ndvi: Array<number | null>;
  relativeScores: Array<number | null>;
  relativeFeatureCount: number[];
  method: string;
}

export interface PhenologyEvidence {
  method: string;
  estimated: boolean;
  confidence: number;
  observationCount: number;
  availableFeatures: SatelliteFeature[];
  maximumGapDays?: number;
  greenupDate?: string | null;
  springGrowthRatePerDay?: number | null;
  peakCanopyDate?: string | null;
  maximums?: Partial<
    Record<SatelliteFeature, { value: number | null; date: string | null }>
  >;
  areaUnderCurveIndexDays?: number;
  areaUnderCurveMean?: number;
  highCanopyDurationDays?: number;
  senescenceOnsetDate?: string | null;
  senescenceRatePerDay?: number | null;
  lateSeasonPersistence?: number | null;
  lateSeasonGapDays?: number;
  normalCurveComparisonCount?: number;
  normalCurveRmse?: number | null;
  normalCurveSignedDeviation?: number | null;
}

export interface PerformanceSeason {
  id: string;
  harvestYear: number;
  cropCode: string;
  cropGroup: string;
  seasonType: string;
  evidenceTier?: SeasonEvidenceTier;
  evidenceReason?: string;
  coverageDays?: number;
  windowStart: string;
  windowEnd: string;
  windowConfidence: number;
  windowMethod: string;
  boundaryConfidence?: number;
  dataQuality: number;
  qualityWeight: number;
  weatherClass: WeatherClass;
  waterBalanceMm: number | null;
  waterBalanceZ: number | null;
  temperatureZ: number | null;
  gddBase5: number | null;
  soilMoisture: number | null;
  phenology: PhenologyEvidence;
  dates: PerformanceDate[];
  scores: Array<number | null>;
  withinSeasonVariability: Array<number | null>;
  observationCounts: number[];
}

export interface ExcludedPerformanceSeason {
  id: string;
  harvestYear: number;
  cropCode: string;
  usableObservationCount: number;
  prePeakObservationCount: number;
  postPeakObservationCount: number;
  reason: string;
}

export interface PerformancePayload {
  fieldCode: string;
  fieldName: string;
  recordedHectares: number | null;
  pixelSizeMetres: number;
  width: number;
  height: number;
  gridOffset: [number, number];
  cells: Array<[number, number, number]>;
  seasons: PerformanceSeason[];
  excludedSeasons?: ExcludedPerformanceSeason[];
  availableYears: [number, number] | [];
  cropCodes: string[];
  method: Record<string, string>;
}

export interface PerformanceFilters {
  cropFilter: string;
  yearFrom: number;
  yearTo: number;
  comparisonMode: ComparisonMode;
  referenceCrop?: string;
  minQuality: number;
  evidenceFilter?: SeasonEvidenceFilter;
}

export interface CellSeasonEvidence {
  seasonId: string;
  harvestYear: number;
  cropCode: string;
  weatherClass: WeatherClass;
  score: number;
  observations: number;
  dataQuality: number;
  boundaryConfidence: number;
  evidenceTier: SeasonEvidenceTier;
  evidenceReason?: string;
  weight: number;
}

export interface CellMetrics {
  score: number | null;
  trendPerYear: number | null;
  trendStartYear: number | null;
  trendEndYear: number | null;
  confidence: number;
  variability: number | null;
  validObservations: number;
  seasonCount: number;
  cropCodes: string[];
  weatherClasses: WeatherClass[];
  wetResponse: number | null;
  dryResponse: number | null;
  wetEvidenceLevel: WeatherEvidenceLevel;
  dryEvidenceLevel: WeatherEvidenceLevel;
  wetEventYears: number[];
  dryEventYears: number[];
  wetBaselineSpread: number | null;
  dryBaselineSpread: number | null;
  dominantCrop: string | null;
  dominantCropShare: number;
  dominantSeason: number | null;
  dominantSeasonShare: number;
  evidence: CellSeasonEvidence[];
}

export interface FieldPerformanceSummary {
  cells: number;
  classifiedCells: number;
  seasons: number;
  crops: string[];
  years: [number, number] | null;
  medianObservations: number;
  confidence: { high: number; medium: number; low: number };
  performance: { weak: number; average: number; strong: number };
  warnings: string[];
}

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function weightedMean(values: Array<{ value: number; weight: number }>) {
  const weight = values.reduce((total, row) => total + row.weight, 0);
  if (!weight) return null;
  return (
    values.reduce((total, row) => total + row.value * row.weight, 0) / weight
  );
}

function weightedDeviation(
  values: Array<{ value: number; weight: number }>,
  mean: number,
) {
  const weight = values.reduce((total, row) => total + row.weight, 0);
  if (!weight) return null;
  const variance =
    values.reduce(
      (total, row) => total + (row.value - mean) ** 2 * row.weight,
      0,
    ) / weight;
  return Math.sqrt(Math.max(0, variance));
}

function groupedWeight(
  evidence: CellSeasonEvidence[],
  key: (row: CellSeasonEvidence) => string,
) {
  const grouped = new Map<string, number>();
  for (const row of evidence) {
    grouped.set(key(row), (grouped.get(key(row)) ?? 0) + row.weight);
  }
  return grouped;
}

function largestShare(grouped: Map<string, number>) {
  const total = [...grouped.values()].reduce((sum, value) => sum + value, 0);
  if (!total || !grouped.size) return { key: null, share: 0 };
  const [key, value] = [...grouped.entries()].sort(
    (left, right) => right[1] - left[1],
  )[0];
  return { key, share: value / total };
}

function weatherResponse(
  evidence: CellSeasonEvidence[],
  target: "wet" | "dry",
) {
  const recognised = evidence.filter((row) =>
    ["wet", "dry", "typical"].includes(row.weatherClass),
  );
  const targetRows = recognised
    .filter((row) => row.weatherClass === target)
    .map((row) => ({ value: row.score, weight: row.weight }));
  const comparisonRows = recognised
    .filter((row) => row.weatherClass !== target)
    .map((row) => ({ value: row.score, weight: row.weight }));
  if (!targetRows.length || comparisonRows.length < 3) {
    return {
      response: null,
      level: "none" as WeatherEvidenceLevel,
      eventYears: [],
      baselineSpread: null,
    };
  }
  const targetMean = weightedMean(targetRows);
  const comparisonMean = weightedMean(comparisonRows);
  const comparisonSpread =
    comparisonMean === null
      ? null
      : weightedDeviation(comparisonRows, comparisonMean);
  if (
    targetMean === null ||
    comparisonMean === null ||
    comparisonSpread === null
  ) {
    return {
      response: null,
      level: "none" as WeatherEvidenceLevel,
      eventYears: [],
      baselineSpread: comparisonSpread,
    };
  }
  const eventYears = recognised
    .filter((row) => row.weatherClass === target)
    .map((row) => row.harvestYear)
    .sort((left, right) => left - right);
  if (targetRows.length >= 3) {
    return {
      response: targetMean - comparisonMean,
      level: "supported-sensitivity" as WeatherEvidenceLevel,
      eventYears,
      baselineSpread: comparisonSpread,
    };
  }
  // One or two event years are useful only where the other seasons establish
  // a stable spatial position. This is an event departure, not a replicated
  // weather effect.
  if (comparisonSpread > 12) {
    return {
      response: null,
      level: "none" as WeatherEvidenceLevel,
      eventYears,
      baselineSpread: comparisonSpread,
    };
  }
  const residuals = targetRows.map((row) => row.value - comparisonMean);
  if (
    residuals.length === 2 &&
    Math.sign(residuals[0]) !== Math.sign(residuals[1])
  ) {
    return {
      response: null,
      level: "none" as WeatherEvidenceLevel,
      eventYears,
      baselineSpread: comparisonSpread,
    };
  }
  return {
    response: targetMean - comparisonMean,
    level: (targetRows.length === 1
      ? "observed-once"
      : "repeated-indication") as WeatherEvidenceLevel,
    eventYears,
    baselineSpread: comparisonSpread,
  };
}

function relativeTrend(evidence: CellSeasonEvidence[]) {
  const grouped = new Map<number, Array<{ value: number; weight: number }>>();
  for (const row of evidence) {
    const values = grouped.get(row.harvestYear) ?? [];
    values.push({ value: row.score, weight: row.weight });
    grouped.set(row.harvestYear, values);
  }
  const points = [...grouped.entries()]
    .map(([year, values]) => ({ year, score: weightedMean(values) }))
    .filter(
      (row): row is { year: number; score: number } => row.score !== null,
    )
    .sort((left, right) => left.year - right.year);
  if (
    points.length < 3 ||
    points.at(-1)!.year - points[0].year < 2
  ) {
    return { perYear: null, startYear: null, endYear: null };
  }
  const slopes: number[] = [];
  for (let earlier = 0; earlier < points.length - 1; earlier += 1) {
    for (let later = earlier + 1; later < points.length; later += 1) {
      slopes.push(
        (points[later].score - points[earlier].score) /
          (points[later].year - points[earlier].year),
      );
    }
  }
  return {
    perYear: median(slopes),
    startYear: points[0].year,
    endYear: points.at(-1)!.year,
  };
}

export function filterPerformanceSeasons(
  seasons: PerformanceSeason[],
  filters: PerformanceFilters,
) {
  const sameCrop =
    filters.comparisonMode === "same-crop"
      ? filters.referenceCrop ||
        (filters.cropFilter.startsWith("group:")
          ? ""
          : filters.cropFilter === "all"
            ? ""
            : filters.cropFilter)
      : "";
  return seasons.filter((season) => {
    const cropMatches =
      filters.cropFilter === "all" ||
      (filters.cropFilter.startsWith("group:")
        ? season.cropGroup === filters.cropFilter.slice(6)
        : season.cropCode === filters.cropFilter);
    return (
      season.harvestYear >= filters.yearFrom &&
      season.harvestYear <= filters.yearTo &&
      season.dataQuality >= filters.minQuality &&
      (filters.evidenceFilter !== "full-only" ||
        (season.evidenceTier ?? "full-season") === "full-season") &&
      cropMatches &&
      (!sameCrop || season.cropCode === sameCrop)
    );
  });
}

export function calculateCellMetrics(
  payload: PerformancePayload,
  filters: PerformanceFilters,
) {
  const seasons = filterPerformanceSeasons(payload.seasons, filters);
  return payload.cells.map(([, , edgeReliability], cellIndex): CellMetrics => {
    const evidence = seasons.flatMap((season): CellSeasonEvidence[] => {
      const score = season.scores[cellIndex];
      const observations = season.observationCounts[cellIndex] ?? 0;
      if (score === null || score === undefined || observations < 4) return [];
      const observationSupport = 0.7 + 0.3 * Math.min(1, observations / 4);
      return [
        {
          seasonId: season.id,
          harvestYear: season.harvestYear,
          cropCode: season.cropCode,
          weatherClass: season.weatherClass,
          score,
          observations,
          dataQuality: season.dataQuality,
          boundaryConfidence: season.boundaryConfidence ?? 0.85,
          evidenceTier: season.evidenceTier ?? "full-season",
          evidenceReason: season.evidenceReason,
          weight:
            season.qualityWeight * observationSupport * edgeReliability,
        },
      ];
    });
    const values = evidence.map((row) => ({
      value: row.score,
      weight: row.weight,
    }));
    const mean = weightedMean(values);
    const score = evidence.length >= 2 && mean !== null ? mean : null;
    const variability =
      score === null ? null : weightedDeviation(values, score);
    const cropDominance = largestShare(
      groupedWeight(evidence, (row) => row.cropCode),
    );
    const yearDominance = largestShare(
      groupedWeight(evidence, (row) => String(row.harvestYear)),
    );
    const cropCodes = [...new Set(evidence.map((row) => row.cropCode))];
    const weatherClasses = [
      ...new Set(evidence.map((row) => row.weatherClass)),
    ];
    const recognisedWeather = weatherClasses.filter((value) =>
      ["wet", "dry", "typical"].includes(value),
    );
    const totalWeight = evidence.reduce((total, row) => total + row.weight, 0);
    const quality =
      totalWeight > 0
        ? evidence.reduce(
            (total, row) => total + (row.dataQuality / 100) * row.weight,
            0,
          ) / totalWeight
        : 0;
    const observationCount = evidence.reduce(
      (total, row) => total + row.observations,
      0,
    );
    const observationAdequacy = evidence.length
      ? Math.min(
          1,
          median(evidence.map((row) => row.observations)) / 6,
        )
      : 0;
    const evidenceDepth =
      Math.min(1, evidence.length / 6) * (0.7 + 0.3 * observationAdequacy);
    const cropBreadth =
      filters.comparisonMode === "same-crop"
        ? 1
        : Math.min(1, cropCodes.length / 3);
    const weatherBreadth = Math.min(1, recognisedWeather.length / 3);
    const cropBalance =
      filters.comparisonMode === "same-crop"
        ? 1
        : clamp(1 - Math.max(0, cropDominance.share - 0.5) * 1.2, 0.45, 1);
    const yearBalance = clamp(
      1 - Math.max(0, yearDominance.share - 0.35),
      0.55,
      1,
    );
    const boundaryConfidence =
      totalWeight > 0
        ? evidence.reduce(
            (total, row) => total + row.boundaryConfidence * row.weight,
            0,
          ) / totalWeight
        : 0;
    const confidenceBase =
      evidenceDepth * 0.4 +
      quality * 0.3 +
      cropBreadth * 0.15 +
      weatherBreadth * 0.15;
    const confidence =
      score === null
        ? Math.round(confidenceBase * 100 * 0.35)
        : Math.round(
            confidenceBase *
              cropBalance *
              yearBalance *
              boundaryConfidence *
            100,
          );
    const wetEvidence = weatherResponse(evidence, "wet");
    const dryEvidence = weatherResponse(evidence, "dry");
    const trend = relativeTrend(evidence);
    return {
      score: score === null ? null : Math.round(score * 10) / 10,
      trendPerYear:
        trend.perYear === null ? null : Math.round(trend.perYear * 10) / 10,
      trendStartYear: trend.startYear,
      trendEndYear: trend.endYear,
      confidence: clamp(confidence, 0, 100),
      variability:
        variability === null ? null : Math.round(variability * 10) / 10,
      validObservations: observationCount,
      seasonCount: evidence.length,
      cropCodes,
      weatherClasses,
      wetResponse:
        score === null
          ? null
          : Math.round((wetEvidence.response ?? NaN) * 10) / 10,
      dryResponse:
        score === null
          ? null
          : Math.round((dryEvidence.response ?? NaN) * 10) / 10,
      wetEvidenceLevel: score === null ? "none" : wetEvidence.level,
      dryEvidenceLevel: score === null ? "none" : dryEvidence.level,
      wetEventYears: wetEvidence.eventYears,
      dryEventYears: dryEvidence.eventYears,
      wetBaselineSpread: wetEvidence.baselineSpread,
      dryBaselineSpread: dryEvidence.baselineSpread,
      dominantCrop: cropDominance.key,
      dominantCropShare: Math.round(cropDominance.share * 100),
      dominantSeason: yearDominance.key ? Number(yearDominance.key) : null,
      dominantSeasonShare: Math.round(yearDominance.share * 100),
      evidence: [...evidence].sort(
        (left, right) => right.harvestYear - left.harvestYear,
      ),
    };
  }).map((metric) => ({
    ...metric,
    wetResponse: Number.isFinite(metric.wetResponse) ? metric.wetResponse : null,
    dryResponse: Number.isFinite(metric.dryResponse) ? metric.dryResponse : null,
  }));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentage(count: number, total: number) {
  return total ? Math.round((count / total) * 100) : 0;
}

export function summariseField(
  metrics: CellMetrics[],
  seasons: PerformanceSeason[],
): FieldPerformanceSummary {
  const classified = metrics.filter((cell) => cell.score !== null);
  const crops = [...new Set(seasons.map((season) => season.cropCode))];
  const years = seasons.map((season) => season.harvestYear);
  const high = classified.filter((cell) => cell.confidence >= 70).length;
  const medium = classified.filter(
    (cell) => cell.confidence >= 45 && cell.confidence < 70,
  ).length;
  const low = classified.length - high - medium;
  const weak = classified.filter((cell) => (cell.score ?? 50) < 40).length;
  const strong = classified.filter((cell) => (cell.score ?? 50) >= 60).length;
  const average = classified.length - weak - strong;
  const warnings: string[] = [];
  if (seasons.length < 3) {
    warnings.push("Fewer than three independent crop seasons pass the filters.");
  }
  if (crops.length < 2) {
    warnings.push("The result represents one crop only.");
  }
  if (
    classified.some(
      (cell) => cell.dominantCropShare > 60 || cell.dominantSeasonShare > 35,
    )
  ) {
    warnings.push("Some cells are dominated by one crop or harvest year.");
  }
  if (classified.length < metrics.length) {
    warnings.push(
      `${percentage(metrics.length - classified.length, metrics.length)}% of the field has insufficient persistent evidence.`,
    );
  }
  if (seasons.some((season) => (season.boundaryConfidence ?? 0.85) < 1)) {
    warnings.push(
      "Some crop years use a provisional current boundary because an older boundary was unavailable; only those years receive a confidence penalty.",
    );
  }
  const limitedSeasons = seasons.filter(
    (season) =>
      (season.evidenceTier ?? "full-season") !== "full-season",
  );
  if (limitedSeasons.length) {
    warnings.push(
      `${limitedSeasons.length} crop year${limitedSeasons.length === 1 ? " uses" : "s use"} partial or grass-seasonal spatial evidence at reduced weight; unsupported phenology is withheld.`,
    );
  }
  return {
    cells: metrics.length,
    classifiedCells: classified.length,
    seasons: seasons.length,
    crops,
    years: years.length ? [Math.min(...years), Math.max(...years)] : null,
    medianObservations: Math.round(
      median(classified.map((cell) => cell.validObservations)),
    ),
    confidence: {
      high: percentage(high, classified.length),
      medium: percentage(medium, classified.length),
      low: percentage(low, classified.length),
    },
    performance: {
      weak: percentage(weak, classified.length),
      average: percentage(average, classified.length),
      strong: percentage(strong, classified.length),
    },
    warnings,
  };
}

function quantile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function quantileThresholds(values: number[], classCount: number) {
  return Array.from(
    { length: classCount - 1 },
    (_, index) => quantile(values, (index + 1) / classCount),
  );
}

function classForScore(score: number, thresholds: number[]) {
  return thresholds.reduce(
    (zoneClass, threshold) => zoneClass + Number(score >= threshold),
    0,
  );
}

function connectedComponent(
  start: number,
  classes: Array<number | null>,
  positions: Array<[number, number, number]>,
  positionIndex: Map<string, number>,
  visited: Set<number>,
) {
  const target = classes[start];
  const component: number[] = [];
  const queue = [start];
  visited.add(start);
  while (queue.length) {
    const index = queue.shift()!;
    component.push(index);
    const [column, row] = positions[index];
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      const neighbour = positionIndex.get(`${column + dx}:${row + dy}`);
      if (
        neighbour !== undefined &&
        !visited.has(neighbour) &&
        classes[neighbour] === target
      ) {
        visited.add(neighbour);
        queue.push(neighbour);
      }
    }
  }
  return component;
}

export function generateManagementZones(
  metrics: CellMetrics[],
  positions: Array<[number, number, number]>,
  classCount: 3 | 4 | 5,
  minimumAreaHectares: number,
) {
  const positionIndex = new Map(
    positions.map(([column, row], index) => [`${column}:${row}`, index]),
  );
  const smoothed = metrics.map((metric, index) => {
    if (metric.score === null) return null;
    const [column, row] = positions[index];
    const neighbours = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        if (!dx && !dy) continue;
        const neighbour = positionIndex.get(`${column + dx}:${row + dy}`);
        const score = neighbour === undefined ? null : metrics[neighbour].score;
        if (score !== null) neighbours.push(score);
      }
    }
    if (!neighbours.length) return metric.score;
    const neighbourMedian = median(neighbours);
    const preserveFeature =
      metric.confidence >= 75 &&
      Math.abs(metric.score - neighbourMedian) >= 18;
    const ownWeight = preserveFeature ? 0.85 : 0.65;
    return metric.score * ownWeight + neighbourMedian * (1 - ownWeight);
  });
  const finiteScores = smoothed.flatMap((score) => (score === null ? [] : [score]));
  const thresholds = quantileThresholds(finiteScores, classCount);
  const classes = smoothed.map((score) =>
    score === null ? null : classForScore(score, thresholds),
  );
  const classCentres = Array.from({ length: classCount }, (_, zoneClass) => {
    const values = smoothed.flatMap((score, index) =>
      score !== null && classes[index] === zoneClass ? [score] : [],
    );
    return values.length ? median(values) : quantile(finiteScores, (zoneClass + 0.5) / classCount);
  });
  const minimumCells = Math.max(1, Math.round(minimumAreaHectares * 100));

  for (let pass = 0; pass < 2; pass += 1) {
    const snapshot = [...classes];
    const visited = new Set<number>();
    const updates = new Map<number, number>();
    for (let index = 0; index < snapshot.length; index += 1) {
      if (snapshot[index] === null || visited.has(index)) continue;
      const component = connectedComponent(
        index,
        snapshot,
        positions,
        positionIndex,
        visited,
      );
      if (component.length >= minimumCells) continue;
      const componentConfidence = median(
        component.map((cell) => metrics[cell].confidence),
      );
      const componentScore = median(
        component.flatMap((cell) =>
          metrics[cell].score === null ? [] : [metrics[cell].score],
        ),
      );
      const neighbouring = new Map<number, number>();
      for (const cell of component) {
        const [column, row] = positions[cell];
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]) {
          const neighbour = positionIndex.get(`${column + dx}:${row + dy}`);
          const zoneClass = neighbour === undefined ? null : snapshot[neighbour];
          if (
            zoneClass !== null &&
            zoneClass !== undefined &&
            zoneClass !== snapshot[cell]
          ) {
            neighbouring.set(
              zoneClass,
              (neighbouring.get(zoneClass) ?? 0) + 1,
            );
          }
        }
      }
      if (!neighbouring.size) continue;
      const targetClass = [...neighbouring.entries()].sort(
        (left, right) =>
          right[1] - left[1] ||
          Math.abs(classCentres[left[0]] - componentScore) -
            Math.abs(classCentres[right[0]] - componentScore) ||
          left[0] - right[0],
      )[0][0];
      const targetMidpoint = classCentres[targetClass];
      const preserveFeature =
        componentConfidence >= 75 &&
        Math.abs(componentScore - targetMidpoint) >= 18;
      if (!preserveFeature) {
        for (const cell of component) updates.set(cell, targetClass);
      }
    }
    for (const [cell, zoneClass] of updates) classes[cell] = zoneClass;
  }
  return classes;
}

export function describeWeatherResponse(
  response: number | null,
  weather: "wet" | "dry",
  evidenceLevel: WeatherEvidenceLevel = "supported-sensitivity",
  eventYears: number[] = [],
) {
  if (response === null) return `Insufficient ${weather}-season contrast`;
  const direction =
    response <= -8
      ? `relatively weaker in ${weather} conditions`
      : response >= 8
        ? `relatively stronger in ${weather} conditions`
        : `broadly stable in ${weather} conditions`;
  const years = eventYears.length ? ` (${eventYears.join(", ")})` : "";
  if (evidenceLevel === "observed-once") {
    return `Observed once${years}: ${direction}`;
  }
  if (evidenceLevel === "repeated-indication") {
    return `Repeated indication${years}: ${direction}`;
  }
  return `${direction[0].toUpperCase()}${direction.slice(1)}`;
}
