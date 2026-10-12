import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import contract from "../schemas/farm-ingestion.json" with { type: "json" };
import { validateFarmInput } from "../scripts/validate-farm-input.mjs";
import { sourceCropToTaxonomy } from "../lib/farm-data.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = path.join(root, "fixtures/demo-farm");
const profile = JSON.parse(await readFile(path.join(fixture, "profile.json"), "utf8"));
const boundaries = JSON.parse(await readFile(path.join(fixture, "source/boundaries.geojson"), "utf8"));
const history = await readFile(path.join(fixture, "raw/history.tsv"), "utf8");
const row = Object.fromEntries(contract.history.columns.map((column, index) =>
  [column, history.trimEnd().split("\n")[1].split("\t")[index]]));

test("preparation template and every canonical crop agree with the input contract and UI", async () => {
  const template = await readFile(path.join(root, "templates/history.tsv"), "utf8");
  assert.equal(template.trimEnd(), contract.history.columns.join("\t"));
  for (const [crop, group] of Object.entries(contract.history.cropGroups)) {
    validateFarmInput(profile, boundaries, [{...row, crop_normalised: crop, crop_simplified: group}]);
    if (!["unknown", "grass"].includes(crop)) {
      assert.equal(sourceCropToTaxonomy(crop, "field-a"), crop.replaceAll("_", "-"));
    }
  }
});

test("unknown crops and missing optional areas and varieties remain valid", () => {
  validateFarmInput(profile, boundaries, [{...row, Hectares: "", Acres: "0", Crop: "", Variety: "", crop_normalised: "unknown", crop_simplified: "unknown"}]);
});

test("preparation rejects ambiguous records and malformed geometry", async (t) => {
  const cases = [
    ["missing identity", [{...row, "Field code": ""}], profile, boundaries, /requires Field code/],
    ["bad harvest year", [{...row, Year: "not a year"}], profile, boundaries, /harvest year/],
    ["bad area", [{...row, Hectares: "-2"}], profile, boundaries, /non-negative/],
    ["unknown code", [{...row, crop_normalised: "wheat"}], profile, boundaries, /unsupported/],
    ["wrong group", [{...row, crop_simplified: "break"}], profile, boundaries, /must be cereal/],
    ["two crops in one field-year", [row, {...row, crop_normalised: "spring_beans", crop_simplified: "break"}], profile, boundaries, /split-field/],
    ["renamed identity", [row, {...row, Field: "Another field", Year: "2024"}], profile, boundaries, /different names/],
    ["empty history", [], profile, boundaries, /at least one/],
    ["missing profile", [row], {...profile, crs: ""}, boundaries, /requires.*crs/],
    ["wrong CRS", [row], {...profile, crs: "EPSG:4326"}, boundaries, /metric WGS84 UTM/],
    ["missing UUID", [row], profile, {type: "FeatureCollection", features: [{...boundaries.features[0], properties: {field_name: "Example field"}}]}, /uuid/],
    ["duplicate UUID", [row], profile, {...boundaries, features: [boundaries.features[0], boundaries.features[0]]}, /duplicate uuid/],
  ];
  const openRing = structuredClone(boundaries);
  openRing.features[0].geometry.coordinates[0][0].pop();
  cases.push(["open ring", [row], profile, openRing, /closed rings/]);
  const wrongCoordinates = structuredClone(boundaries);
  wrongCoordinates.features[0].geometry.coordinates[0][0][0] = [500000, 6100000];
  cases.push(["projected coordinates", [row], profile, wrongCoordinates, /WGS84 longitude/]);
  for (const [name, rows, candidateProfile, candidateBoundaries, message] of cases) {
    await t.test(name, () => assert.throws(() => validateFarmInput(candidateProfile, candidateBoundaries, rows), message));
  }
});

test("check mode uses import matching, preserves existing files and writes nothing", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "farm-preparation-"));
  await cp(fixture, workspace, {recursive: true});
  const script = path.join(root, "scripts/import-farm-data.mjs");
  const geometryPath = path.join(workspace, "source/boundaries.geojson");
  const historyPath = path.join(workspace, "raw/history.tsv");
  const args = [workspace, geometryPath, historyPath];
  const files = await readdir(path.join(workspace, "source"));
  const before = await Promise.all(files.map((file) => readFile(path.join(workspace, "source", file), "utf8")));
  const {stdout} = await run(process.execPath, [script, "--check", ...args]);
  const checked = JSON.parse(stdout);
  assert.equal(checked.validated, true);
  assert.equal(checked.filesWritten, 0);
  assert.ok(checked.warnings.some((warning) => warning.includes("not imported")));
  assert.deepEqual(await readdir(path.join(workspace, "source")), files);
  assert.deepEqual(await Promise.all(files.map((file) => readFile(path.join(workspace, "source", file), "utf8"))), before);
  const {stdout: imported} = await run(process.execPath, [script, ...args]);
  const counts = {...checked};
  delete counts.validated;
  delete counts.filesWritten;
  delete counts.warnings;
  assert.deepEqual(JSON.parse(imported), counts);

  await writeFile(historyPath, history.replace("Field_Year", "wrong-header"));
  for (const flags of [["--check"], []]) {
    await assert.rejects(run(process.execPath, [script, ...flags, ...args]), /History headers must match/);
  }
  await writeFile(historyPath, history.replaceAll("Example field", "Unmatched field"));
  await assert.rejects(run(process.execPath, [script, "--check", ...args]), /No history field matches/);
});
