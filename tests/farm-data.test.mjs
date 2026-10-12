import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  ACTIVE_FARM,
  FARM_BOUNDARY_COUNT,
  FARM_FIELD_COUNT,
  FARM_HISTORY_ROW_COUNT,
  FARM_SEASONS,
  LEGACY_DEMO_SEASON_IDS,
  isLegacyDemoDataset,
  linkFarmDerivedEvidence,
  sourceCropToTaxonomy,
} from "../lib/farm-data.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

test("loads the active farm through the generic profile boundary", async () => {
  const history = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "data/active-farm/history.json"),
      "utf8",
    ),
  );
  const boundaries = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "public/data/active-farm/boundaries.geojson"),
      "utf8",
    ),
  );

  assert.equal(FARM_HISTORY_ROW_COUNT, history.length);
  assert.equal(FARM_SEASONS.length, history.length);
  assert.equal(FARM_FIELD_COUNT, new Set(history.map((row) => row.fieldCode)).size);
  assert.equal(FARM_BOUNDARY_COUNT, boundaries.features.length);
  assert.ok(FARM_SEASONS.every((season) => season.id.startsWith(`${ACTIVE_FARM.id}-`)));
  assert.ok(
    FARM_SEASONS.every(
      (season) => season.sourceDataset === ACTIVE_FARM.historyLabel,
    ),
  );
});

test("maps source taxonomy without depending on a named farm", () => {
  const arableField = FARM_SEASONS.find((season) =>
    ["winter-wheat", "spring-wheat", "winter-barley", "spring-barley"].includes(
      season.cropCode,
    ),
  );
  assert.ok(arableField);
  assert.equal(sourceCropToTaxonomy("spring_barley", arableField.fieldId), "spring-barley");
  assert.equal(sourceCropToTaxonomy("winter_barley", arableField.fieldId), "winter-barley");
  assert.equal(sourceCropToTaxonomy("unknown-value", arableField.fieldId), "unknown");
});

test("keeps historical geometry and missing dates explicit", () => {
  assert.ok(
    FARM_SEASONS.every(
      (season) =>
        season.sowingDate === "" &&
        season.harvestDate === "" &&
        Object.keys(season.zoneScores).length === 0,
    ),
  );
  assert.ok(
    FARM_SEASONS.filter(
      (season) => season.harvestYear !== ACTIVE_FARM.currentHarvestYear,
    ).every((season) => season.boundaryVersion === "Historical boundary not supplied"),
  );
});

test("generic importer writes only inside the selected farm workspace", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "satellite-productivity-detection-farm-"),
  );
  const workspace = path.join(temporaryRoot, "farm");
  await cp(path.join(repositoryRoot, "fixtures/demo-farm"), workspace, {
    recursive: true,
  });
  const script = path.join(repositoryRoot, "scripts/import-farm-data.mjs");
  const boundaries = path.join(workspace, "source/boundaries.geojson");
  const history = path.join(workspace, "raw/history.tsv");
  const historySource = await readFile(history, "utf8");
  await writeFile(
    history,
    historySource.replace("\t1\t2.47\t2023\t", "\t0\t0\t2023\t"),
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [script, workspace, boundaries, history],
    { cwd: temporaryRoot },
  );

  assert.deepEqual(JSON.parse(stdout), {
    historyRows: 4,
    historyFields: 1,
    boundaryFeatures: 1,
    exactBoundaryMatches: 1,
    aliasBoundaryMatches: 0,
    historyOnlyFields: 0,
  });
  const importedHistory = JSON.parse(
    await readFile(path.join(workspace, "source/history.json"), "utf8"),
  );
  assert.equal(importedHistory.length, 4);
  assert.equal(importedHistory[0].hectares, null);
  assert.equal(importedHistory[0].acres, null);
  assert.equal(importedHistory[1].hectares, 1);
});

test("legacy fixture detection remains exact", () => {
  assert.equal(isLegacyDemoDataset(LEGACY_DEMO_SEASON_IDS), true);
  assert.equal(isLegacyDemoDataset(LEGACY_DEMO_SEASON_IDS.slice(1)), false);
  assert.equal(
    isLegacyDemoDataset([...LEGACY_DEMO_SEASON_IDS, "user-record"]),
    false,
  );
});

test("derived evidence refresh never overwrites a user weather source", () => {
  const source = FARM_SEASONS.find((season) => season.ndviProvenance);
  assert.ok(source);
  const stored = {
    ...source,
    weatherClass: "dry",
    weatherSummary: "Farm rain gauge and local notes",
    weatherProvenance: "Farm records",
    observationCount: 0,
    usableObservationCount: 0,
    dataQuality: 0,
    ndviProvenance: undefined,
  };
  const refreshed = linkFarmDerivedEvidence(stored);
  assert.equal(refreshed.weatherClass, "dry");
  assert.equal(refreshed.weatherProvenance, "Farm records");
  assert.ok(refreshed.observationCount > 0);
});
