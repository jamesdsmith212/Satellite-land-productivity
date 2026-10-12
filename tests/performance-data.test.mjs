import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

async function loadIndex() {
  return JSON.parse(
    await readFile(
      path.join(repositoryRoot, "data/active-farm/performance-summary.json"),
      "utf8",
    ),
  );
}

async function loadField(index) {
  const field = index.fields[0];
  assert.ok(field);
  const fieldPath = path.join(
    repositoryRoot,
    "public",
    field.url.replace(/^\//, ""),
  );
  return JSON.parse(await readFile(fieldPath, "utf8"));
}

test("performance index references every active mapped field", async () => {
  const summary = await loadIndex();

  assert.equal(summary.methodVersion, "persistent-performance-v4-evidence-tiers");
  assert.equal(summary.fieldCount, summary.fields.length);
  assert.ok(summary.fieldCount > 0);
  assert.ok(summary.farmGrid.width > 0);
  assert.ok(summary.farmGrid.height > 0);
  assert.equal(summary.farmGrid.pixelSizeMetres, 10);
  assert.ok(summary.fields.every((field) => field.cellCount > 0));
  await Promise.all(
    summary.fields.map((field) =>
      access(
        path.join(repositoryRoot, "public", field.url.replace(/^\//, "")),
      ),
    ),
  );
  assert.equal(summary.features.ndre.native_support_metres, 20);
  assert.equal(summary.features.evi2.native_support_metres, 10);
  assert.match(summary.radar.requiredProduct, /terrain-corrected/);
});

test("portable synthetic performance data uses the corrected method version", async () => {
  const fixture = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "fixtures/demo-farm/derived/performance-summary.json",
      ),
      "utf8",
    ),
  );
  assert.equal(fixture.methodVersion, "persistent-performance-v4-evidence-tiers");
});

test("field model keeps cells aligned across crop seasons", async () => {
  const index = await loadIndex();
  const model = await loadField(index);

  assert.equal(model.pixelSizeMetres, 10);
  assert.ok(model.cells.length > 0);
  assert.ok(model.seasons.length > 0);
  assert.ok(
    model.seasons.every(
      (season) =>
        season.scores.length === model.cells.length &&
        season.observationCounts.length === model.cells.length &&
        season.withinSeasonVariability.length === model.cells.length,
    ),
  );
  assert.ok(
    model.seasons
      .flatMap((season) => season.scores)
      .filter((score) => score !== null)
      .every((score) => score >= 0 && score <= 100),
  );
  assert.match(model.method.seasonIndependence, /season/i);
});

test("individual satellite dates preserve all optical features", async () => {
  const index = await loadIndex();
  const fieldModel = await loadField(index);
  const observation = fieldModel.seasons
    .flatMap((season) => season.dates)
    .find((candidate) => candidate.cellUrl);
  assert.ok(observation);

  const dateModel = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "public",
        observation.cellUrl.replace(/^\//, ""),
      ),
      "utf8",
    ),
  );
  assert.equal(dateModel.fieldCode, fieldModel.fieldCode);
  assert.equal(dateModel.date, observation.date);
  assert.equal(dateModel.ndvi.length, fieldModel.cells.length);
  assert.equal(dateModel.relativeScores.length, fieldModel.cells.length);
  assert.deepEqual(
    Object.keys(dateModel.features).sort(),
    [
      "evi2",
      "ndre",
      "ndvi",
      "ndwi",
      "nir08",
      "rededge1",
      "rededge2",
      "rededge3",
      "swir16",
      "swir22",
    ],
  );
  assert.equal(dateModel.nativeSupportMetres.ndre, 20);
  assert.equal(dateModel.displayPixelSizeMetres, 10);
});
