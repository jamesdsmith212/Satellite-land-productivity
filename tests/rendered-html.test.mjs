import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

test("declares the map-first active-farm performance workspace", async () => {
  const [page, workspace, model, recordsPage] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/performance-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/performance.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/records/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /title: "Historical field performance"/);
  assert.match(page, /PerformanceWorkspace/);
  assert.match(workspace, /Satellite Productivity Detection/);
  assert.match(workspace, /Long-term relative performance/);
  assert.match(workspace, /What the map shows/);
  assert.match(workspace, /Crops included/);
  assert.match(workspace, /Comparison method/);
  assert.match(workspace, /Multi-index satellite estimate of relative historical crop performance/);
  assert.match(workspace, /Individual 10 m cells/);
  assert.match(workspace, /Wet-year departure from usual position/);
  assert.match(workspace, /Whole farm/);
  assert.match(workspace, /Click any field to inspect its source imagery/);
  assert.match(workspace, /Crop-year composite/);
  assert.match(workspace, /Source satellite date/);
  assert.match(workspace, /equal multi-index relative position/);
  assert.match(workspace, /NDRE/);
  assert.match(workspace, /native 20 m/);
  assert.match(workspace, /Estimated crop-stage trajectories/);
  assert.match(workspace, /Longer historical record/);
  assert.match(workspace, /Explanation:/);
  assert.match(workspace, /Selected 10 m cell/);
  assert.match(workspace, /Crop history & evidence/);
  assert.match(model, /calculateCellMetrics/);
  assert.match(model, /generateManagementZones/);
  assert.match(recordsPage, /RotationWorkspace/);
  assert.doesNotMatch(workspace, /Soil sampling|Nutrient scenario|Field report/);
  assert.doesNotMatch(
    page + workspace,
    /codex-preview|Your site is taking shape|North Beck|Synthetic validation field/i,
  );
});

test("removes the disposable starter preview", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  await assert.rejects(access(new URL("../app/_sites-preview", templateRoot)));
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.match(layout, /Satellite Productivity Detection/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
