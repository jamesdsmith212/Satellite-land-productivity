import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_FIELD_SEASON_BODY_BYTES,
  FieldSeasonInputError,
  LocalOnlyAccessError,
  readFieldSeasonRecords,
  requireLocalRequest,
} from "../lib/field-season-input.ts";

function record(overrides = {}) {
  return {
    id: "field-2026",
    fieldId: "field",
    fieldName: "Field",
    harvestYear: 2026,
    sowingDate: "",
    harvestDate: "",
    ...overrides,
  };
}

test("accepts incomplete but structurally valid local field-season dates", async () => {
  const records = await readFieldSeasonRecords(
    new Request("http://localhost/api/field-seasons", {
      method: "POST",
      body: JSON.stringify({ records: [record()] }),
    }),
    "records",
  );
  assert.equal(records.length, 1);
});

test("rejects malformed required dates before a database write", async () => {
  await assert.rejects(
    readFieldSeasonRecords(
      new Request("http://localhost/api/field-seasons", {
        method: "POST",
        body: JSON.stringify({ records: [record({ sowingDate: "2026-02-30" })] }),
      }),
      "records",
    ),
    (error) => error instanceof FieldSeasonInputError && error.status === 400,
  );
});

test("rejects oversized bodies even without trusting content length", async () => {
  const body = JSON.stringify({ records: [record()], padding: "x".repeat(MAX_FIELD_SEASON_BODY_BYTES) });
  await assert.rejects(
    readFieldSeasonRecords(
      new Request("http://localhost/api/field-seasons", { method: "POST", body }),
      "records",
    ),
    (error) => error instanceof FieldSeasonInputError && error.status === 413,
  );
});

test("local field-season storage does not trust a caller-supplied identity header", async () => {
  const source = await readFile(new URL("../db/rotation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /oai-authenticated-user-email|headers\.get/i);
  assert.match(source, /LOCAL_OWNER_KEY/);
  assert.match(source, /requireLocalOwner/);
});

test("field-season API access is restricted to loopback URLs", () => {
  assert.doesNotThrow(() =>
    requireLocalRequest(new Request("http://127.0.0.1/api/field-seasons")),
  );
  assert.throws(
    () => requireLocalRequest(new Request("https://example.com/api/field-seasons")),
    LocalOnlyAccessError,
  );
});
