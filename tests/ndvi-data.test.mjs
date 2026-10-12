import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

test("active Sentinel-2 summary is internally consistent", async () => {
  const summary = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "data/active-farm/ndvi-summary.json"),
      "utf8",
    ),
  );

  assert.equal(summary.processedSceneCount, summary.growingSeasonItemCount);
  assert.equal(summary.sceneErrorCount, 0);
  assert.equal(summary.seasons.length, summary.fieldSeasonCount);
  assert.ok(summary.usableFieldSeasonCount <= summary.fieldSeasonCount);
  if (summary.source.features) {
    assert.equal(summary.source.features.ndvi.native_support_metres, 10);
    assert.equal(summary.source.features.ndre.native_support_metres, 20);
    assert.equal(summary.source.features.ndwi.native_support_metres, 20);
    assert.match(summary.method.displayResampling, /display grid only/);
  }
  assert.ok(
    summary.seasons.every(
      (season) =>
        season.candidateObservationCount >= season.usableObservationCount &&
        (season.modelEligible === undefined ||
          season.modelEligible ===
            (season.usableObservationCount >= 4 &&
              season.prePeakObservationCount >= 2 &&
              season.postPeakObservationCount >= 1)),
    ),
  );
});

test("optical ingestion no longer writes a second crop-year composite", async () => {
  const source = await readFile(
    path.join(repositoryRoot, "scripts/fetch-ndvi.py"),
    "utf8",
  );

  assert.doesNotMatch(source, /season-composites|cellUrl|compositeFile/);
  assert.match(source, /modelEligible/);
});
