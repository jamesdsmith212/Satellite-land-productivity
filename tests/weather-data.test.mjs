import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FARM_SEASONS } from "../lib/farm-data.ts";

const repositoryRoot = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

test("active weather summary keeps provenance inspectable", async () => {
  const summary = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "data/active-farm/weather-summary.json"),
      "utf8",
    ),
  );

  assert.ok(summary.lastAvailableDate);
  assert.ok(summary.source.temperatureAndSoilMoisture.model);
  assert.ok(summary.source.precipitationAndEt0.model);
  assert.ok(summary.source.method);
  assert.ok(Object.keys(summary.harvestYears).length > 0);
});

test("crop-aware weather windows remain distinct", () => {
  const winterCrop = FARM_SEASONS.find(
    (season) => season.cropCode.startsWith("winter-"),
  );
  const springCrop = FARM_SEASONS.find(
    (season) => season.cropCode.startsWith("spring-"),
  );
  const grassCrop = FARM_SEASONS.find((season) =>
    season.cropCode.endsWith("-grass"),
  );

  if (winterCrop) assert.equal(winterCrop.weatherWindow, "winter");
  if (springCrop) assert.equal(springCrop.weatherWindow, "spring");
  if (grassCrop) assert.equal(grassCrop.weatherWindow, "grass");
  assert.ok(winterCrop || springCrop || grassCrop);
});

test("weather evidence is labelled as modelled rather than farm-station data", () => {
  assert.ok(
    FARM_SEASONS.every((season) => season.weatherProvenance),
  );
  assert.ok(
    FARM_SEASONS.every(
      (season) => !season.weatherSummary.toLowerCase().includes("on-farm station observation"),
    ),
  );
});
