import assert from "node:assert/strict";
import test from "node:test";
import {
  analyseZone,
  associateObservationToSeason,
  auditSeason,
  cropName,
  emptySeason,
  filterSeasons,
  getCrop,
} from "../lib/rotation.ts";

const rotation = [
  {
    year: 2019,
    cropCode: "winter-wheat",
    previousCropCode: "winter-oilseed-rape",
    rotationPosition: "First cereal",
    weatherClass: "typical",
    peakNdvi: 0.84,
  },
  {
    year: 2020,
    cropCode: "winter-wheat",
    previousCropCode: "winter-wheat",
    rotationPosition: "Second cereal",
    weatherClass: "wet",
    peakNdvi: 0.76,
  },
  {
    year: 2021,
    cropCode: "spring-barley",
    previousCropCode: "winter-wheat",
    rotationPosition: "Consecutive cereal",
    weatherClass: "dry",
    peakNdvi: 0.7,
  },
  {
    year: 2022,
    cropCode: "winter-beans",
    previousCropCode: "spring-barley",
    rotationPosition: "Break crop",
    weatherClass: "typical",
    peakNdvi: 0.88,
  },
  {
    year: 2023,
    cropCode: "winter-wheat",
    previousCropCode: "winter-beans",
    rotationPosition: "First cereal",
    weatherClass: "typical",
    peakNdvi: 0.85,
  },
  {
    year: 2024,
    cropCode: "spring-beans",
    previousCropCode: "winter-wheat",
    rotationPosition: "Break crop",
    weatherClass: "wet",
    peakNdvi: 0.79,
  },
  {
    year: 2025,
    cropCode: "winter-wheat",
    previousCropCode: "spring-beans",
    rotationPosition: "First cereal",
    weatherClass: "dry",
    peakNdvi: 0.86,
  },
  {
    year: 2026,
    cropCode: "winter-wheat",
    previousCropCode: "winter-wheat",
    rotationPosition: "Second cereal",
    weatherClass: "wet",
    peakNdvi: 0.74,
  },
];

test("filters analysis evidence by crop-window weather class", () => {
  const records = rotation.map((row, index) =>
    completeSeason({
      id: `weather-filter-${index}`,
      harvestYear: row.year,
      cropCode: row.cropCode,
      previousCropCode: row.previousCropCode,
      rotationPosition: row.rotationPosition,
      weatherClass: row.weatherClass,
    }),
  );
  const wet = filterSeasons(records, { weatherClass: "wet" });
  assert.ok(wet.length > 0);
  assert.ok(wet.every((record) => record.weatherClass === "wet"));
});

function scores(row) {
  const crop = getCrop(row.cropCode);
  const secondCereal = /second|continuous|consecutive|third/i.test(
    row.rotationPosition,
  );
  const wetAutumn = row.weatherClass === "wet" && crop.season === "winter";
  return {
    persistentWeak: -0.18,
    wheatWeak: row.cropCode === "winter-wheat" ? -0.15 : 0.02,
    springWeak: crop.season === "spring" ? -0.16 : 0.01,
    secondCereal: secondCereal ? -0.18 : 0.02,
    afterBeans:
      row.previousCropCode === "spring-beans" ||
      row.previousCropCode === "winter-beans"
        ? 0.07
        : crop.group === "cereal"
          ? -0.1
          : -0.01,
    wetAutumn: wetAutumn ? -0.17 : 0.01,
    persistentStrong: 0.14,
  };
}

function completeSeason(input) {
  return {
    ...emptySeason(),
    id: input.id,
    fieldId: input.fieldId ?? "TEST-1",
    fieldName: input.fieldName ?? "Test fixture",
    portion: input.portion ?? "Whole field",
    boundaryVersion: input.boundaryVersion ?? "TEST-V1",
    harvestYear: input.harvestYear,
    cropCode: input.cropCode,
    previousCropCode: input.previousCropCode,
    sowingDate: input.sowingDate,
    harvestDate: input.harvestDate,
    rotationPosition: input.rotationPosition,
    weatherClass: input.weatherClass,
    weatherSummary: "Synthetic test-only weather class",
    observationCount: 12,
    usableObservationCount: 10,
    dataQuality: 85,
    peakNdvi: input.peakNdvi,
    zoneScores: input.zoneScores,
  };
}

const validationSeasons = rotation.map((row) =>
  completeSeason({
    ...row,
    id: `test-${row.year}`,
    harvestYear: row.year,
    sowingDate: `${row.year - (getCrop(row.cropCode).season === "winter" ? 1 : 0)}-${
      getCrop(row.cropCode).season === "winter" ? "10-01" : "03-15"
    }`,
    harvestDate: `${row.year}-08-15`,
    zoneScores: scores(row),
  }),
);

test("classifies a patch weak across contrasting crops as persistent", () => {
  const result = analyseZone(validationSeasons, "persistentWeak");
  assert.equal(result.classification, "Persistently weak across crops");
  assert.equal(result.crossCropAvailable, true);
  assert.ok(result.evidence.some((row) => getCrop(row.cropCode).group === "break"));
  assert.ok(result.evidence.some((row) => getCrop(row.cropCode).group === "cereal"));
});

test("retains crop-specific weakness as a diagnostic signal", () => {
  const result = analyseZone(validationSeasons, "wheatWeak");
  assert.equal(result.classification, "Weak mainly in cereals");
  assert.ok(result.signals.some((signal) => signal.includes("Winter wheat")));
});

test("distinguishes spring-crop and second-cereal responses", () => {
  assert.equal(
    analyseZone(validationSeasons, "springWeak").classification,
    "Weak mainly in spring crops",
  );
  assert.equal(
    analyseZone(validationSeasons, "secondCereal").classification,
    "Sensitive to second-cereal position",
  );
});

test("finds improvement following beans without diagnosing its cause", () => {
  const result = analyseZone(validationSeasons, "afterBeans");
  assert.ok(result.signals.some((signal) => signal.includes("following beans")));
  assert.ok(result.evidence.some((row) => row.previousCrop === "Spring beans"));
});

test("finds wet-establishment sensitivity", () => {
  assert.equal(
    analyseZone(validationSeasons, "wetAutumn").classification,
    "Sensitive to wet seasons",
  );
});

test("never uses crop-specific raw peak NDVI for cross-crop persistence", () => {
  assert.ok(new Set(validationSeasons.map((record) => record.peakNdvi)).size > 3);
  const result = analyseZone(validationSeasons, "persistentStrong");
  assert.equal(result.classification, "Persistently strong across crops");
  assert.ok(result.evidence.every((row) => "relativePerformance" in row));
  assert.ok(!("peakNdvi" in result));
});

test("lowers confidence and reports all unavailable inputs", () => {
  const missing = {
    ...emptySeason(),
    id: "missing",
    fieldId: "MISSING",
    fieldName: "Missing test record",
    harvestYear: 2025,
    zoneScores: { persistentWeak: -0.2 },
  };
  const result = analyseZone([missing], "persistentWeak");
  assert.equal(result.classification, "Insufficient rotational evidence");
  assert.equal(result.confidenceLabel, "Low");
  const warnings = auditSeason(missing);
  assert.ok(warnings.some((warning) => warning.includes("Crop is unknown")));
  assert.ok(warnings.some((warning) => warning.includes("Weather is missing")));
  assert.ok(warnings.some((warning) => warning.includes("Satellite observations")));
});

test("flags an incorrectly designated winter crop", () => {
  const incorrect = {
    ...validationSeasons[0],
    id: "incorrect",
    sowingDate: "2025-03-20",
    harvestYear: 2025,
    harvestDate: "2025-08-20",
  };
  assert.ok(
    auditSeason(incorrect).some((warning) => warning.includes("spring sowing")),
  );
});

test("requires explicit portions for split fields", () => {
  const split = ["East split", "West split"].map((portion) =>
    completeSeason({
      id: `split-${portion}`,
      fieldId: "SPLIT",
      fieldName: "Split field",
      portion,
      boundaryVersion: `SPLIT-${portion}`,
      harvestYear: 2025,
      cropCode: portion === "East split" ? "spring-barley" : "winter-beans",
      previousCropCode: "temporary-grass",
      sowingDate: "2025-03-01",
      harvestDate: "2025-09-01",
      rotationPosition: portion === "East split" ? "First cereal" : "Break crop",
      weatherClass: "typical",
      peakNdvi: 0.8,
      zoneScores: {},
    }),
  );
  assert.equal(
    associateObservationToSeason(
      { fieldId: "SPLIT", observedOn: "2025-05-20" },
      split,
    ).status,
    "ambiguous",
  );
  assert.deepEqual(
    associateObservationToSeason(
      {
        fieldId: "SPLIT",
        portion: "East split",
        boundaryVersion: "SPLIT-East split",
        observedOn: "2025-05-20",
      },
      split,
    ),
    { status: "associated", seasonId: "split-East split" },
  );
});

test("uses boundary versions and harvest-year naming", () => {
  const season = validationSeasons.at(-1);
  const associated = associateObservationToSeason(
    {
      fieldId: "TEST-1",
      portion: "Whole field",
      boundaryVersion: "TEST-V1",
      observedOn: "2026-05-16",
    },
    validationSeasons,
  );
  assert.deepEqual(associated, {
    status: "associated",
    seasonId: "test-2026",
  });
  assert.equal(season?.sowingDate.slice(0, 4), "2025");
  assert.equal(season?.harvestYear, 2026);
  assert.equal(cropName(season?.cropCode ?? ""), "Winter wheat");
});
