import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateLandsatMetrics,
  sentinelScoresByLandsatCell,
  sourceAgreement,
} from "../lib/landsat-performance.ts";

const filters = {
  cropFilter: "all",
  yearFrom: 2008,
  yearTo: 2026,
  comparisonMode: "all-crop",
  minQuality: 0,
};

test("Landsat remains a crop-filterable native-resolution evidence track", () => {
  const payload = {
    field: { fieldCode: "A", fieldName: "A", recordedHectares: 1 },
    nativeSupportMetres: 30,
    cells: [{ id: 0, row: 0, column: 0 }],
    seasons: [
      { id: "a", harvestYear: 2018, crop: "winter_wheat", observationCount: 4, modelEligible: true, compositeScores: [20] },
      { id: "b", harvestYear: 2020, crop: "winter_wheat", observationCount: 5, modelEligible: true, compositeScores: [40] },
      { id: "c", harvestYear: 2022, crop: "winter_wheat", observationCount: 6, modelEligible: true, compositeScores: [60] },
    ],
  };
  const metric = calculateLandsatMetrics(payload, filters)[0];
  assert.equal(metric.score, 40);
  assert.equal(metric.trendPerYear, 10);
  assert.equal(metric.seasonCount, 3);
});

test("Sentinel cell centres are honestly aggregated into the Landsat grid", () => {
  const sentinelGrid = {
    width: 3,
    height: 3,
    geotransform: [0, 10, 0, 30, 0, -10],
  };
  const landsatGrid = {
    width: 1,
    height: 1,
    geotransform: [0, 30, 0, 30, 0, -30],
  };
  const values = sentinelScoresByLandsatCell(
    [{
      gridOffset: [0, 0],
      cells: [[0, 0, 1], [1, 0, 1], [2, 0, 1]],
      scores: [30, 60, 90],
    }],
    sentinelGrid,
    landsatGrid,
  );
  assert.equal(values.get("0:0"), 60);
  assert.equal(sourceAgreement(55, values.get("0:0")), 95);
  assert.equal(sourceAgreement(null, 60), null);
});
