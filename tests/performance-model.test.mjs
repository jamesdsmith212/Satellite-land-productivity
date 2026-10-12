import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCellMetrics,
  filterPerformanceSeasons,
  generateManagementZones,
  summariseField,
} from "../lib/performance.ts";

function season({
  id,
  year,
  crop,
  group = "cereal",
  weather = "typical",
  score,
  observations = 4,
  quality = 90,
}) {
  return {
    id,
    harvestYear: year,
    cropCode: crop,
    cropGroup: group,
    seasonType: crop.startsWith("spring") ? "spring" : "winter",
    windowStart: `${year}-02-15`,
    windowEnd: `${year}-06-30`,
    windowConfidence: 0.8,
    windowMethod: "Synthetic test window",
    dataQuality: quality,
    qualityWeight: quality / 100,
    weatherClass: weather,
    waterBalanceMm: 0,
    waterBalanceZ: 0,
    temperatureZ: 0,
    gddBase5: 1000,
    soilMoisture: 0.25,
    dates: [],
    scores: [score],
    withinSeasonVariability: [4],
    observationCounts: [observations],
  };
}

const filters = {
  cropFilter: "all",
  yearFrom: 2018,
  yearTo: 2026,
  comparisonMode: "all-crop",
  minQuality: 50,
};

function payload(seasons) {
  return {
    fieldCode: "TEST",
    fieldName: "Test field",
    recordedHectares: 1,
    pixelSizeMetres: 10,
    width: 1,
    height: 1,
    gridOffset: [0, 0],
    cells: [[0, 0, 1]],
    seasons,
    availableYears: [2018, 2026],
    cropCodes: [...new Set(seasons.map((row) => row.cropCode))],
    method: {},
  };
}

test("combines independent crop seasons rather than weighting scene-rich years directly", () => {
  const model = payload([
    season({
      id: "few-scenes",
      year: 2023,
      crop: "winter_wheat",
      score: 20,
      observations: 4,
    }),
    season({
      id: "many-scenes",
      year: 2024,
      crop: "winter_wheat",
      score: 80,
      observations: 20,
    }),
  ]);
  const result = calculateCellMetrics(model, {
    ...filters,
    comparisonMode: "same-crop",
    referenceCrop: "winter_wheat",
  })[0];

  assert.ok(result.score >= 45 && result.score <= 55);
  assert.equal(result.seasonCount, 2);
  assert.equal(result.validObservations, 24);
});

test("crop and crop-group filters control the contributing seasons", () => {
  const seasons = [
    season({ id: "wheat", year: 2023, crop: "winter_wheat", score: 30 }),
    season({
      id: "beans",
      year: 2024,
      crop: "spring_beans",
      group: "break",
      score: 75,
    }),
    season({ id: "barley", year: 2025, crop: "spring_barley", score: 60 }),
  ];
  assert.deepEqual(
    filterPerformanceSeasons(seasons, {
      ...filters,
      cropFilter: "group:break",
    }).map((row) => row.id),
    ["beans"],
  );
  assert.deepEqual(
    filterPerformanceSeasons(seasons, {
      ...filters,
      comparisonMode: "same-crop",
      referenceCrop: "winter_wheat",
    }).map((row) => row.id),
    ["wheat"],
  );
});

test("strict evidence filter preserves the full-trajectory baseline", () => {
  const full = season({
    id: "full",
    year: 2023,
    crop: "winter_wheat",
    score: 40,
  });
  full.evidenceTier = "full-season";
  const partial = season({
    id: "partial",
    year: 2024,
    crop: "winter_wheat",
    score: 80,
  });
  partial.evidenceTier = "partial-season";
  assert.deepEqual(
    filterPerformanceSeasons([full, partial], {
      ...filters,
      evidenceFilter: "full-only",
    }).map((row) => row.id),
    ["full"],
  );
  assert.deepEqual(
    filterPerformanceSeasons([full, partial], {
      ...filters,
      evidenceFilter: "include-limited",
    }).map((row) => row.id),
    ["full", "partial"],
  );
});

test("one season is not mislabelled as persistent evidence", () => {
  const result = calculateCellMetrics(
    payload([
      season({
        id: "single",
        year: 2025,
        crop: "winter_wheat",
        score: 15,
      }),
    ]),
    filters,
  )[0];
  assert.equal(result.score, null);
  assert.ok(result.confidence < 30);
});

test("robust trend identifies relative improvement without following one outlier", () => {
  const result = calculateCellMetrics(
    payload(
      [20, 30, 90, 50, 60].map((score, index) =>
        season({
          id: `trend-${index}`,
          year: 2020 + index,
          crop: "winter_wheat",
          score,
        }),
      ),
    ),
    filters,
  )[0];

  assert.equal(result.trendPerYear, 10);
  assert.equal(result.trendStartYear, 2020);
  assert.equal(result.trendEndYear, 2024);
});

test("relative trend requires at least three independent crop seasons", () => {
  const result = calculateCellMetrics(
    payload([
      season({ id: "early", year: 2023, crop: "winter_wheat", score: 20 }),
      season({ id: "late", year: 2025, crop: "winter_wheat", score: 80 }),
    ]),
    filters,
  )[0];

  assert.equal(result.trendPerYear, null);
  assert.equal(result.trendStartYear, null);
  assert.equal(result.trendEndYear, null);
});

test("weather sensitivity withholds samples of fewer than three per side", () => {
  const result = calculateCellMetrics(
    payload([
      season({
        id: "wet",
        year: 2024,
        crop: "winter_wheat",
        weather: "wet",
        score: 25,
      }),
      season({
        id: "dry",
        year: 2025,
        crop: "winter_wheat",
        weather: "dry",
        score: 75,
      }),
      season({
        id: "typical",
        year: 2023,
        crop: "winter_wheat",
        weather: "typical",
        score: 70,
      }),
    ]),
    filters,
  )[0];
  assert.equal(result.wetResponse, null);
  assert.equal(result.dryResponse, null);
});

test("one wet year is retained as an observation against a stable baseline", () => {
  const result = calculateCellMetrics(
    payload([
      season({
        id: "wet-event",
        year: 2024,
        crop: "winter_wheat",
        weather: "wet",
        score: 30,
      }),
      ...[2020, 2021, 2022, 2023].map((year, index) =>
        season({
          id: `baseline-${year}`,
          year,
          crop: "winter_wheat",
          weather: "typical",
          score: 69 + index,
        }),
      ),
    ]),
    filters,
  )[0];

  assert.equal(result.wetEvidenceLevel, "observed-once");
  assert.deepEqual(result.wetEventYears, [2024]);
  assert.ok(result.wetResponse < -35);
  assert.ok(result.wetBaselineSpread < 2);
});

test("one event year is withheld when the usual spatial position is unstable", () => {
  const result = calculateCellMetrics(
    payload([
      season({
        id: "wet-event",
        year: 2024,
        crop: "winter_wheat",
        weather: "wet",
        score: 30,
      }),
      ...[20, 80, 25, 75].map((score, index) =>
        season({
          id: `baseline-${index}`,
          year: 2020 + index,
          crop: "winter_wheat",
          weather: "typical",
          score,
        }),
      ),
    ]),
    filters,
  )[0];

  assert.equal(result.wetEvidenceLevel, "none");
  assert.equal(result.wetResponse, null);
  assert.ok(result.wetBaselineSpread > 12);
});

test("weather sensitivity compares adequately replicated weather classes", () => {
  const seasons = [
    ...[2020, 2021, 2022].map((year, index) =>
      season({
        id: `wet-${year}`,
        year,
        crop: "winter_wheat",
        weather: "wet",
        score: 25 + index,
      }),
    ),
    ...[2023, 2024, 2025].map((year, index) =>
      season({
        id: `dry-${year}`,
        year,
        crop: "winter_wheat",
        weather: "dry",
        score: 70 + index,
      }),
    ),
  ];
  const result = calculateCellMetrics(payload(seasons), filters)[0];

  assert.ok(result.wetResponse < -40);
  assert.ok(result.dryResponse > 40);
  assert.equal(result.wetEvidenceLevel, "supported-sensitivity");
  assert.equal(result.dryEvidenceLevel, "supported-sensitivity");
});

test("confidence rewards seasons, crops and weather diversity", () => {
  const sparse = calculateCellMetrics(
    payload([
      season({ id: "a", year: 2023, crop: "winter_wheat", score: 35 }),
      season({ id: "b", year: 2024, crop: "winter_wheat", score: 40 }),
    ]),
    filters,
  )[0];
  const diverseSeasons = [
    season({
      id: "c1",
      year: 2021,
      crop: "winter_wheat",
      weather: "wet",
      score: 35,
    }),
    season({
      id: "c2",
      year: 2022,
      crop: "spring_barley",
      weather: "dry",
      score: 42,
    }),
    season({
      id: "c3",
      year: 2023,
      crop: "spring_beans",
      group: "break",
      weather: "typical",
      score: 38,
    }),
    season({
      id: "c4",
      year: 2024,
      crop: "winter_wheat",
      weather: "wet",
      score: 36,
    }),
    season({
      id: "c5",
      year: 2025,
      crop: "spring_barley",
      weather: "dry",
      score: 40,
    }),
    season({
      id: "c6",
      year: 2026,
      crop: "spring_beans",
      group: "break",
      weather: "unknown",
      score: 39,
    }),
  ];
  const diverse = calculateCellMetrics(payload(diverseSeasons), filters)[0];
  assert.ok(diverse.confidence > sparse.confidence);
  assert.ok(diverse.confidence >= 65);
  assert.equal(summariseField([diverse], diverseSeasons).confidence.high, 100);
});

function zoneMetric(score, confidence = 60) {
  return {
    score,
    confidence,
    variability: 5,
    validObservations: 20,
    seasonCount: 5,
    cropCodes: ["winter_wheat"],
    weatherClasses: ["wet", "dry"],
    wetResponse: 0,
    dryResponse: 0,
    dominantCrop: "winter_wheat",
    dominantCropShare: 100,
    dominantSeason: 2024,
    dominantSeasonShare: 20,
    evidence: [],
  };
}

test("zone generation removes low-confidence salt-and-pepper cells", () => {
  const positions = [];
  const metrics = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      positions.push([column, row, 1]);
      metrics.push(zoneMetric(column === 2 && row === 2 ? 10 : 80));
    }
  }
  const zones = generateManagementZones(metrics, positions, 5, 0.03);
  assert.equal(zones[12], zones[11]);
});

test("zone generation preserves a strongly supported narrow feature", () => {
  const positions = [];
  const metrics = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      positions.push([column, row, 1]);
      metrics.push(
        zoneMetric(column === 2 && row === 2 ? 5 : 85, column === 2 && row === 2 ? 90 : 70),
      );
    }
  }
  const zones = generateManagementZones(metrics, positions, 5, 0.03);
  assert.notEqual(zones[12], zones[11]);
});

test("zone classes use the field distribution rather than fixed score intervals", () => {
  const positions = Array.from({ length: 100 }, (_, index) => [index, 0, 1]);
  const metrics = Array.from({ length: 100 }, (_, index) => zoneMetric(20 + index * 0.6));
  const zones = generateManagementZones(metrics, positions, 5, 0.01);
  const counts = new Map();
  for (const zone of zones) counts.set(zone, (counts.get(zone) ?? 0) + 1);

  assert.equal(counts.size, 5);
  assert.ok([...counts.values()].every((count) => count >= 19 && count <= 21));
});

test("zone merging is invariant to cell iteration order", () => {
  const positions = [];
  const metrics = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      positions.push([column, row, 1]);
      metrics.push(zoneMetric(column < 2 ? 25 : row === 2 ? 55 : 80));
    }
  }
  const forward = generateManagementZones(metrics, positions, 4, 0.03);
  const reversedPositions = [...positions].reverse();
  const reversedMetrics = [...metrics].reverse();
  const reversed = generateManagementZones(reversedMetrics, reversedPositions, 4, 0.03);
  const byPosition = new Map(
    reversedPositions.map(([column, row], index) => [`${column}:${row}`, reversed[index]]),
  );

  positions.forEach(([column, row], index) => {
    assert.equal(forward[index], byPosition.get(`${column}:${row}`));
  });
});
