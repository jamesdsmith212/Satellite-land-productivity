export type SeasonType = "winter" | "spring" | "perennial" | "none" | "unknown";
export type CropGroup =
  | "cereal"
  | "break"
  | "grass"
  | "cover"
  | "fallow"
  | "woodland"
  | "unknown";

export interface CropDefinition {
  code: string;
  name: string;
  season: SeasonType;
  group: CropGroup;
  comparableGroup: string;
  typicalPeakNdvi: [number, number] | null;
  canopy: string;
  senescence: string;
  defaultEstablishment: string;
}

export interface FieldSeason {
  id: string;
  fieldId: string;
  fieldName: string;
  portion: string;
  boundaryVersion: string;
  harvestYear: number;
  cropCode: string;
  cropTypeUse: string;
  variety: string;
  previousCropCode: string;
  sowingDate: string;
  harvestDate: string;
  establishmentMethod: string;
  cultivationSystem: string;
  seedRate: string;
  endMarket: string;
  strawManagement: string;
  coverCrop: string;
  organicManure: string;
  drainageWork: string;
  notes: string;
  rotationPosition: string;
  weatherClass: "wet" | "dry" | "typical" | "unknown";
  weatherSummary: string;
  weatherWindow?: "winter" | "spring" | "grass" | "crop_year";
  weatherCoverage?: number;
  waterBalanceMm?: number | null;
  waterBalanceZ?: number | null;
  temperatureZ?: number | null;
  weatherProvenance?: string;
  observationCount: number;
  usableObservationCount: number;
  dataQuality: number;
  peakNdvi: number | null;
  inferredStageCount: number;
  ndviWindowStart?: string;
  ndviWindowEnd?: string;
  ndviWindowMethod?: string;
  ndviWindowComplete?: boolean;
  ndviBoundaryMethod?: string;
  ndviCellCoverage?: number;
  ndviUsableDates?: string[];
  ndviCellUrl?: string;
  performanceFieldUrl?: string;
  ndviProvenance?: string;
  zoneScores: Record<string, number>;
  hectares?: number | null;
  acres?: number | null;
  sourceCrop?: string;
  sourceFieldYear?: string;
  sourceDataset?: string;
}

export const CROP_TAXONOMY: CropDefinition[] = [
  {
    code: "winter-wheat",
    name: "Winter wheat",
    season: "winter",
    group: "cereal",
    comparableGroup: "winter-wheat",
    typicalPeakNdvi: [0.72, 0.9],
    canopy: "Dense, upright cereal canopy",
    senescence: "Rapid from grain fill",
    defaultEstablishment: "Autumn drilled",
  },
  {
    code: "spring-wheat",
    name: "Spring wheat",
    season: "spring",
    group: "cereal",
    comparableGroup: "spring-cereal",
    typicalPeakNdvi: [0.66, 0.86],
    canopy: "Dense cereal canopy",
    senescence: "Rapid from grain fill",
    defaultEstablishment: "Spring drilled",
  },
  {
    code: "winter-feed-barley",
    name: "Winter feed barley",
    season: "winter",
    group: "cereal",
    comparableGroup: "winter-barley",
    typicalPeakNdvi: [0.7, 0.88],
    canopy: "Early, dense cereal canopy",
    senescence: "Earlier than wheat",
    defaultEstablishment: "Autumn drilled",
  },
  {
    code: "winter-malting-barley",
    name: "Winter malting or distilling barley",
    season: "winter",
    group: "cereal",
    comparableGroup: "winter-barley",
    typicalPeakNdvi: [0.7, 0.88],
    canopy: "Early, dense cereal canopy",
    senescence: "Earlier than wheat",
    defaultEstablishment: "Autumn drilled",
  },
  {
    code: "spring-feed-barley",
    name: "Spring feed barley",
    season: "spring",
    group: "cereal",
    comparableGroup: "spring-barley",
    typicalPeakNdvi: [0.64, 0.84],
    canopy: "Short-season cereal canopy",
    senescence: "Fast late-season decline",
    defaultEstablishment: "Spring drilled",
  },
  {
    code: "winter-barley",
    name: "Winter barley — use unknown",
    season: "winter",
    group: "cereal",
    comparableGroup: "winter-barley",
    typicalPeakNdvi: [0.7, 0.88],
    canopy: "Early, dense cereal canopy",
    senescence: "Earlier than wheat",
    defaultEstablishment: "Autumn drilled",
  },
  {
    code: "spring-barley",
    name: "Spring barley — use unknown",
    season: "spring",
    group: "cereal",
    comparableGroup: "spring-barley",
    typicalPeakNdvi: [0.64, 0.84],
    canopy: "Short-season cereal canopy",
    senescence: "Fast late-season decline",
    defaultEstablishment: "Spring drilled",
  },
  {
    code: "spring-malting-barley",
    name: "Spring malting barley",
    season: "spring",
    group: "cereal",
    comparableGroup: "spring-barley",
    typicalPeakNdvi: [0.64, 0.84],
    canopy: "Short-season cereal canopy",
    senescence: "Fast late-season decline",
    defaultEstablishment: "Spring drilled",
  },
  {
    code: "winter-oats",
    name: "Winter oats",
    season: "winter",
    group: "cereal",
    comparableGroup: "winter-oats",
    typicalPeakNdvi: [0.7, 0.88],
    canopy: "Open cereal canopy",
    senescence: "Moderate late-season decline",
    defaultEstablishment: "Autumn drilled",
  },
  {
    code: "spring-oats",
    name: "Spring oats",
    season: "spring",
    group: "cereal",
    comparableGroup: "spring-oats",
    typicalPeakNdvi: [0.64, 0.84],
    canopy: "Open cereal canopy",
    senescence: "Moderate late-season decline",
    defaultEstablishment: "Spring drilled",
  },
  {
    code: "winter-oilseed-rape",
    name: "Winter oilseed rape",
    season: "winter",
    group: "break",
    comparableGroup: "oilseed-rape",
    typicalPeakNdvi: [0.76, 0.93],
    canopy: "Broad-leaved, branching canopy",
    senescence: "Long flowering interruption then decline",
    defaultEstablishment: "Autumn drilled",
  },
  {
    code: "spring-oilseed-rape",
    name: "Spring oilseed rape",
    season: "spring",
    group: "break",
    comparableGroup: "oilseed-rape",
    typicalPeakNdvi: [0.68, 0.88],
    canopy: "Broad-leaved, branching canopy",
    senescence: "Flowering interruption then decline",
    defaultEstablishment: "Spring drilled",
  },
  {
    code: "winter-beans",
    name: "Winter beans",
    season: "winter",
    group: "break",
    comparableGroup: "beans",
    typicalPeakNdvi: [0.72, 0.9],
    canopy: "Tall, open legume canopy",
    senescence: "Patchy late-season decline",
    defaultEstablishment: "Autumn drilled",
  },
  {
    code: "spring-beans",
    name: "Spring beans",
    season: "spring",
    group: "break",
    comparableGroup: "beans",
    typicalPeakNdvi: [0.68, 0.88],
    canopy: "Tall, open legume canopy",
    senescence: "Patchy late-season decline",
    defaultEstablishment: "Spring drilled",
  },
  {
    code: "temporary-grass",
    name: "Temporary grass",
    season: "perennial",
    group: "grass",
    comparableGroup: "grass",
    typicalPeakNdvi: [0.72, 0.94],
    canopy: "Dense multi-cut sward",
    senescence: "Management-led rather than annual",
    defaultEstablishment: "Reseeded",
  },
  {
    code: "permanent-grass",
    name: "Permanent grass",
    season: "perennial",
    group: "grass",
    comparableGroup: "grass",
    typicalPeakNdvi: [0.68, 0.92],
    canopy: "Persistent mixed sward",
    senescence: "Weather and grazing-led",
    defaultEstablishment: "Established sward",
  },
  {
    code: "cover-crop",
    name: "Cover crop",
    season: "none",
    group: "cover",
    comparableGroup: "cover",
    typicalPeakNdvi: null,
    canopy: "Species-mix dependent",
    senescence: "Termination-led",
    defaultEstablishment: "Post-harvest",
  },
  {
    code: "fallow",
    name: "Fallow or uncropped",
    season: "none",
    group: "fallow",
    comparableGroup: "fallow",
    typicalPeakNdvi: null,
    canopy: "No intended crop canopy",
    senescence: "Not applicable",
    defaultEstablishment: "None",
  },
  {
    code: "native-woodland",
    name: "Native woodland",
    season: "none",
    group: "woodland",
    comparableGroup: "woodland",
    typicalPeakNdvi: null,
    canopy: "Persistent woodland canopy",
    senescence: "Species dependent",
    defaultEstablishment: "Not applicable",
  },
  {
    code: "non-native-woodland",
    name: "Non-native woodland",
    season: "none",
    group: "woodland",
    comparableGroup: "woodland",
    typicalPeakNdvi: null,
    canopy: "Persistent woodland canopy",
    senescence: "Species dependent",
    defaultEstablishment: "Not applicable",
  },
  {
    code: "unknown",
    name: "Unknown crop",
    season: "unknown",
    group: "unknown",
    comparableGroup: "unknown",
    typicalPeakNdvi: null,
    canopy: "Unknown",
    senescence: "Unknown",
    defaultEstablishment: "Unknown",
  },
];

const cropByCode = new Map(CROP_TAXONOMY.map((crop) => [crop.code, crop]));

export function getCrop(code: string): CropDefinition {
  return cropByCode.get(code) ?? cropByCode.get("unknown")!;
}

export function cropName(code: string): string {
  return getCrop(code).name;
}

export const ROTATION_DEFINITIONS = {
  breakCropGroups: ["break", "grass", "fallow"],
  cerealCropGroup: "cereal",
  autumnSownSeason: "winter",
  weakThreshold: -0.08,
  strongThreshold: 0.08,
  comparableMinimumSeasons: 2,
  crossCropMinimumCrops: 2,
};

const mean = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function groupedMean<T>(rows: T[], key: (row: T) => string, value: (row: T) => number) {
  const groups = new Map<string, number[]>();
  rows.forEach((row) => {
    const groupKey = key(row);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), value(row)]);
  });
  return [...groups.entries()].map(([name, values]) => ({
    name,
    count: values.length,
    mean: mean(values),
  }));
}

export interface AnalysisFilters {
  cropCode?: string;
  cropGroup?: string;
  season?: string;
  previousCropCode?: string;
  rotationPosition?: string;
  weatherClass?: string;
  startYear?: number;
  endYear?: number;
}

export function filterSeasons(records: FieldSeason[], filters: AnalysisFilters = {}) {
  return records.filter((record) => {
    const crop = getCrop(record.cropCode);
    return (
      (!filters.cropCode || filters.cropCode === "all" || record.cropCode === filters.cropCode) &&
      (!filters.cropGroup || filters.cropGroup === "all" || crop.group === filters.cropGroup) &&
      (!filters.season || filters.season === "all" || crop.season === filters.season) &&
      (!filters.previousCropCode ||
        filters.previousCropCode === "all" ||
        record.previousCropCode === filters.previousCropCode) &&
      (!filters.rotationPosition ||
        filters.rotationPosition === "all" ||
        record.rotationPosition === filters.rotationPosition) &&
      (!filters.weatherClass ||
        filters.weatherClass === "all" ||
        record.weatherClass === filters.weatherClass) &&
      (!filters.startYear || record.harvestYear >= filters.startYear) &&
      (!filters.endYear || record.harvestYear <= filters.endYear)
    );
  });
}

export function analyseZone(
  records: FieldSeason[],
  zoneId: string,
  filters: AnalysisFilters = {},
) {
  const eligible = filterSeasons(records, filters).filter(
    (record) => Number.isFinite(record.zoneScores?.[zoneId]),
  );
  const evidence = eligible.map((record) => ({
    id: record.id,
    harvestYear: record.harvestYear,
    cropCode: record.cropCode,
    crop: cropName(record.cropCode),
    cropGroup: getCrop(record.cropCode).group,
    season: getCrop(record.cropCode).season,
    previousCropCode: record.previousCropCode,
    previousCrop: cropName(record.previousCropCode),
    rotationPosition: record.rotationPosition,
    weatherClass: record.weatherClass,
    relativePerformance: record.zoneScores[zoneId],
    usableObservationCount: record.usableObservationCount,
    dataQuality: record.dataQuality,
    inferredStageCount: record.inferredStageCount,
  }));

  const cropGroups = groupedMean(evidence, (row) => row.cropCode, (row) => row.relativePerformance);
  const groupMeans = groupedMean(evidence, (row) => row.cropGroup, (row) => row.relativePerformance);
  const seasonMeans = groupedMean(evidence, (row) => row.season, (row) => row.relativePerformance);
  const rotationMeans = groupedMean(evidence, (row) => row.rotationPosition, (row) => row.relativePerformance);
  const weatherMeans = groupedMean(evidence, (row) => row.weatherClass, (row) => row.relativePerformance);
  const previousMeans = groupedMean(evidence, (row) => row.previousCropCode, (row) => row.relativePerformance);
  const overallMean = mean(evidence.map((row) => row.relativePerformance));
  const weakRate = evidence.length
    ? evidence.filter((row) => row.relativePerformance <= ROTATION_DEFINITIONS.weakThreshold).length /
      evidence.length
    : 0;
  const strongRate = evidence.length
    ? evidence.filter((row) => row.relativePerformance >= ROTATION_DEFINITIONS.strongThreshold).length /
      evidence.length
    : 0;
  const uniqueCrops = new Set(evidence.map((row) => row.cropCode));
  const valueFor = (groups: { name: string; mean: number }[], name: string) =>
    groups.find((group) => group.name === name)?.mean;
  const springMean = valueFor(seasonMeans, "spring");
  const winterMean = valueFor(seasonMeans, "winter");
  const cerealMean = valueFor(groupMeans, "cereal");
  const breakValues = groupMeans
    .filter((group) => ROTATION_DEFINITIONS.breakCropGroups.includes(group.name))
    .map((group) => group.mean);
  const breakMean = breakValues.length ? mean(breakValues) : undefined;
  const secondValues = rotationMeans
    .filter((group) => /second|continuous|third/i.test(group.name))
    .map((group) => group.mean);
  const firstValues = rotationMeans
    .filter((group) => /first/i.test(group.name))
    .map((group) => group.mean);
  const secondMean = secondValues.length ? mean(secondValues) : undefined;
  const firstMean = firstValues.length ? mean(firstValues) : undefined;
  const wetMean = valueFor(weatherMeans, "wet");
  const dryMean = valueFor(weatherMeans, "dry");
  const typicalMean = valueFor(weatherMeans, "typical");
  const nonWetMeans = [dryMean, typicalMean].filter(
    (value): value is number => value !== undefined,
  );
  const nonDryMeans = [wetMean, typicalMean].filter(
    (value): value is number => value !== undefined,
  );

  let classification = "Highly inconsistent";
  if (
    evidence.length < 3 ||
    (uniqueCrops.size < 2 && !cropGroups.some((group) => group.count >= 2))
  ) {
    classification = "Insufficient rotational evidence";
  } else if (
    springMean !== undefined &&
    winterMean !== undefined &&
    springMean <= -0.08 &&
    springMean <= winterMean - 0.08
  ) {
    classification = "Weak mainly in spring crops";
  } else if (
    wetMean !== undefined &&
    nonWetMeans.length > 0 &&
    wetMean <= -0.08 &&
    wetMean <= mean(nonWetMeans) - 0.1
  ) {
    classification = "Sensitive to wet seasons";
  } else if (
    dryMean !== undefined &&
    nonDryMeans.length > 0 &&
    dryMean <= -0.08 &&
    dryMean <= mean(nonDryMeans) - 0.1
  ) {
    classification = "Sensitive to dry seasons";
  } else if (
    secondMean !== undefined &&
    firstMean !== undefined &&
    secondMean <= -0.08 &&
    secondMean <= firstMean - 0.08
  ) {
    classification = "Sensitive to second-cereal position";
  } else if (
    cerealMean !== undefined &&
    breakMean !== undefined &&
    cerealMean <= -0.08 &&
    cerealMean <= breakMean - 0.07
  ) {
    classification = "Weak mainly in cereals";
  } else if (
    breakMean !== undefined &&
    cerealMean !== undefined &&
    breakMean <= -0.08 &&
    breakMean <= cerealMean - 0.07
  ) {
    classification = "Weak mainly in break crops";
  } else if (
    winterMean !== undefined &&
    springMean !== undefined &&
    winterMean <= -0.08 &&
    winterMean <= springMean - 0.08
  ) {
    classification = "Weak mainly in autumn-sown crops";
  } else if (uniqueCrops.size >= 2 && overallMean <= -0.08 && weakRate >= 0.7) {
    classification = "Persistently weak across crops";
  } else if (uniqueCrops.size >= 2 && overallMean >= 0.08 && strongRate >= 0.7) {
    classification = "Persistently strong across crops";
  }

  const cropCounts = cropGroups.map((group) => group.count);
  const dominantCropShare = evidence.length ? Math.max(0, ...cropCounts) / evidence.length : 0;
  const absTotal = evidence.reduce((sum, row) => sum + Math.abs(row.relativePerformance), 0);
  const dominantYearShare = absTotal
    ? Math.max(...evidence.map((row) => Math.abs(row.relativePerformance))) / absTotal
    : 0;
  let confidenceScore = Math.min(94, 48 + evidence.length * 6 + uniqueCrops.size * 5);
  const confidenceNotes: string[] = [];

  if (evidence.length < 4) {
    confidenceScore -= 20;
    confidenceNotes.push("Fewer than four usable crop seasons.");
  }
  if (uniqueCrops.size < 2) {
    confidenceScore -= 16;
    confidenceNotes.push("Cross-crop persistence cannot be tested.");
  }
  if (dominantCropShare > 0.6) {
    confidenceScore -= 10;
    confidenceNotes.push("Conclusion is dominated by one crop.");
  }
  if (dominantYearShare > 0.45) {
    confidenceScore -= 8;
    confidenceNotes.push("Conclusion is sensitive to one crop year.");
  }
  const missingPrevious = evidence.filter((row) => row.previousCropCode === "unknown").length;
  if (missingPrevious) {
    confidenceScore -= Math.min(18, missingPrevious * 5);
    confidenceNotes.push(`${missingPrevious} season${missingPrevious === 1 ? "" : "s"} lack a preceding crop.`);
  }
  const inferredStages = evidence.reduce((sum, row) => sum + row.inferredStageCount, 0);
  if (inferredStages) {
    confidenceScore -= Math.min(12, inferredStages);
    confidenceNotes.push(`${inferredStages} seasonal window${inferredStages === 1 ? "" : "s"} use estimated crop stage.`);
  }
  const weakQuality = evidence.filter((row) => row.dataQuality < 60 || row.usableObservationCount < 6).length;
  if (weakQuality) {
    confidenceScore -= Math.min(15, weakQuality * 5);
    confidenceNotes.push(`${weakQuality} season${weakQuality === 1 ? "" : "s"} have weak satellite coverage.`);
  }
  confidenceScore = Math.max(12, Math.round(confidenceScore));

  const signals: string[] = [];
  const afterBeans = previousMeans
    .filter((group) => /beans/.test(group.name))
    .map((group) => group.mean);
  const afterOther = previousMeans
    .filter((group) => !/beans/.test(group.name))
    .map((group) => group.mean);
  if (afterBeans.length && afterOther.length && mean(afterBeans) - mean(afterOther) >= 0.08) {
    signals.push(
      `Relative performance improves by ${Math.round((mean(afterBeans) - mean(afterOther)) * 100)} points following beans.`,
    );
  }
  cropGroups.forEach((group) => {
    const other = cropGroups.filter((candidate) => candidate.name !== group.name).map((candidate) => candidate.mean);
    if (other.length && group.mean <= -0.08 && group.mean <= mean(other) - 0.08) {
      signals.push(`${cropName(group.name)} is a crop-specific weak signal.`);
    }
  });
  if (!signals.length) {
    signals.push(
      classification.includes("Persistent")
        ? "Direction is consistent across contrasting crop groups."
        : "No single rotation effect clears the descriptive threshold.",
    );
  }

  return {
    zoneId,
    classification,
    confidenceScore,
    confidenceLabel:
      confidenceScore >= 80 ? "High" : confidenceScore >= 60 ? "Moderate" : "Low",
    confidenceNotes,
    overallMean,
    evidence,
    cropGroups,
    sameCropGroups: cropGroups.filter(
      (group) => group.count >= ROTATION_DEFINITIONS.comparableMinimumSeasons,
    ),
    crossCropAvailable: uniqueCrops.size >= ROTATION_DEFINITIONS.crossCropMinimumCrops,
    dominantCrop:
      cropGroups.sort((a, b) => b.count - a.count)[0]?.name ?? "unknown",
    dominantCropShare,
    dominantYear:
      [...evidence].sort(
        (a, b) => Math.abs(b.relativePerformance) - Math.abs(a.relativePerformance),
      )[0]?.harvestYear,
    dominantYearShare,
    rotationPositions: [...new Set(evidence.map((row) => row.rotationPosition))],
    precedingCrops: [...new Set(evidence.map((row) => row.previousCrop))],
    signals,
  };
}

export function computeRotationMetrics(records: FieldSeason[]) {
  const sorted = [...records].sort((a, b) => a.harvestYear - b.harvestYear);
  const history = sorted.map((record, index) => {
    const prior = sorted.slice(0, index).reverse();
    const crop = getCrop(record.cropCode);
    const previousSame = prior.find((candidate) => candidate.cropCode === record.cropCode);
    const previousBreak = prior.find((candidate) =>
      ROTATION_DEFINITIONS.breakCropGroups.includes(getCrop(candidate.cropCode).group),
    );
    const previousGrass = prior.find((candidate) => candidate.cropCode === "temporary-grass");
    const previousManure = prior.find(
      (candidate) =>
        candidate.organicManure &&
        !/none|unknown/i.test(candidate.organicManure),
    );
    let consecutiveCereals = 0;
    let consecutiveAutumn = 0;
    for (const candidate of [record, ...prior]) {
      if (getCrop(candidate.cropCode).group === "cereal") consecutiveCereals += 1;
      else break;
    }
    for (const candidate of [record, ...prior]) {
      if (getCrop(candidate.cropCode).season === "winter") consecutiveAutumn += 1;
      else break;
    }
    return {
      id: record.id,
      yearsSinceSameCrop: previousSame
        ? record.harvestYear - previousSame.harvestYear
        : null,
      yearsSinceBreakCrop: previousBreak
        ? record.harvestYear - previousBreak.harvestYear
        : null,
      yearsSinceTemporaryGrass: previousGrass
        ? record.harvestYear - previousGrass.harvestYear
        : null,
      yearsSinceOrganicManure: previousManure
        ? record.harvestYear - previousManure.harvestYear
        : null,
      consecutiveCereals: crop.group === "cereal" ? consecutiveCereals : 0,
      consecutiveAutumnSown: crop.season === "winter" ? consecutiveAutumn : 0,
    };
  });
  const known = sorted.filter((record) => getCrop(record.cropCode).group !== "unknown");
  const cropFrequencies = groupedMean(known, (record) => record.cropCode, () => 1).map(
    (group) => ({ cropCode: group.name, count: group.count }),
  );
  const springCount = known.filter((record) => getCrop(record.cropCode).season === "spring").length;
  const proportions = cropFrequencies.map((item) => item.count / Math.max(known.length, 1));
  const rotationDiversity = proportions.length
    ? -proportions.reduce(
        (sum, proportion) => sum + proportion * Math.log(proportion),
        0,
      ) / Math.log(Math.max(proportions.length, 2))
    : 0;

  return {
    history,
    cropFrequencies,
    springProportion: known.length ? springCount / known.length : 0,
    winterProportion: known.length
      ? known.filter((record) => getCrop(record.cropCode).season === "winter").length /
        known.length
      : 0,
    rotationDiversity,
  };
}

export function auditSeason(record: FieldSeason): string[] {
  const warnings: string[] = [];
  const crop = getCrop(record.cropCode);
  if (record.cropCode === "unknown") warnings.push("Crop is unknown; crop-aware comparisons are disabled.");
  if (!record.previousCropCode || record.previousCropCode === "unknown") {
    warnings.push("Preceding crop is missing; rotation-position analysis is weakened.");
  }
  if (!record.sowingDate) warnings.push("Sowing date is missing; stages will be estimated.");
  if (!record.harvestDate) warnings.push("Harvest date is missing; seasonal association is weakened.");
  if (
    !record.boundaryVersion ||
    /not supplied|missing|unknown/i.test(record.boundaryVersion)
  ) {
    warnings.push(
      "A usable boundary version is missing; spatial and split-field association is unsafe.",
    );
  }
  if (record.weatherClass === "unknown" || !record.weatherSummary) {
    warnings.push(
      "Weather is missing; weather-sensitive and establishment-year analysis is unavailable.",
    );
  }
  if (record.observationCount === 0) {
    warnings.push(
      "Satellite observations are missing; spatial persistence cannot be classified.",
    );
  }
  if (record.sowingDate) {
    const month = Number(record.sowingDate.slice(5, 7));
    if (crop.season === "winter" && month >= 2 && month <= 6) {
      warnings.push("Recorded winter crop has a spring sowing date; check crop designation.");
    }
    if (crop.season === "spring" && (month >= 8 || month === 1)) {
      warnings.push("Recorded spring crop has an autumn/winter sowing date; check crop designation.");
    }
  }
  if (
    crop.season === "winter" &&
    record.harvestDate &&
    Number(record.harvestDate.slice(0, 4)) !== record.harvestYear
  ) {
    warnings.push("Winter crop harvest date does not match the harvest-year convention.");
  }
  return warnings;
}

export interface ObservationCandidate {
  fieldId: string;
  boundaryVersion?: string;
  portion?: string;
  observedOn: string;
}

export function associateObservationToSeason(
  observation: ObservationCandidate,
  records: FieldSeason[],
) {
  const sameField = records.filter((record) => record.fieldId === observation.fieldId);
  const splitPortions = new Set(sameField.map((record) => record.portion));
  if (!observation.portion && splitPortions.size > 1) {
    return {
      status: "ambiguous" as const,
      reason: "A split field requires an explicit crop polygon or portion.",
      candidates: sameField.map((record) => record.id),
    };
  }
  const matches = sameField.filter((record) => {
    const boundaryMatches =
      !observation.boundaryVersion ||
      record.boundaryVersion === observation.boundaryVersion;
    const portionMatches = !observation.portion || record.portion === observation.portion;
    const inWindow =
      Boolean(record.sowingDate && record.harvestDate) &&
      observation.observedOn >= record.sowingDate &&
      observation.observedOn <= record.harvestDate;
    return boundaryMatches && portionMatches && inWindow;
  });
  if (matches.length === 1) {
    return { status: "associated" as const, seasonId: matches[0].id };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous" as const,
      reason: "More than one crop season overlaps this observation.",
      candidates: matches.map((record) => record.id),
    };
  }
  return {
    status: "unassociated" as const,
    reason: "No crop season matches the date, boundary version and field portion.",
    candidates: [],
  };
}

export const CSV_HEADER_ALIASES: Record<string, keyof FieldSeason> = {
  field: "fieldName",
  fieldname: "fieldName",
  fieldid: "fieldId",
  stablefieldid: "fieldId",
  portion: "portion",
  fieldportion: "portion",
  boundaryversion: "boundaryVersion",
  harvestyear: "harvestYear",
  year: "harvestYear",
  crop: "cropCode",
  croptype: "cropTypeUse",
  cropuse: "cropTypeUse",
  variety: "variety",
  previouscrop: "previousCropCode",
  precedingcrop: "previousCropCode",
  sowingdate: "sowingDate",
  harvestdate: "harvestDate",
  establishmentmethod: "establishmentMethod",
  cultivationsystem: "cultivationSystem",
  seedrate: "seedRate",
  endmarket: "endMarket",
  straw: "strawManagement",
  strawmanagement: "strawManagement",
  covercrop: "coverCrop",
  organicmanure: "organicManure",
  drainagework: "drainageWork",
  notes: "notes",
  rotationposition: "rotationPosition",
};

export function normaliseCropCode(value: string): string {
  const normalised = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const exact = CROP_TAXONOMY.find(
    (crop) => crop.code === normalised || crop.name.toLowerCase() === value.trim().toLowerCase(),
  );
  return exact?.code ?? "unknown";
}

export function emptySeason(): FieldSeason {
  return {
    id: "",
    fieldId: "",
    fieldName: "",
    portion: "Whole field",
    boundaryVersion: "",
    harvestYear: new Date().getFullYear(),
    cropCode: "unknown",
    cropTypeUse: "",
    variety: "",
    previousCropCode: "unknown",
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
    notes: "",
    rotationPosition: "Unknown",
    weatherClass: "unknown",
    weatherSummary: "",
    observationCount: 0,
    usableObservationCount: 0,
    dataQuality: 0,
    peakNdvi: null,
    inferredStageCount: 0,
    zoneScores: {},
  };
}
