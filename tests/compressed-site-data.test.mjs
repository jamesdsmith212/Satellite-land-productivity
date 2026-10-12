import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";

import { serveCompressedSiteData } from "../lib/compressed-site-data.ts";

test("serves a compressed hosted data file at its original JSON URL", async () => {
  const payload = JSON.stringify({ farm: "Example", cells: [1, 2, 3] });
  let requestedPath = "";
  const assets = {
    async fetch(request) {
      requestedPath = new URL(request.url).pathname;
      assert.equal(request.headers.get("accept-encoding"), null);
      return new Response(gzipSync(payload));
    },
  };

  const response = await serveCompressedSiteData(
    new Request("https://example.com/data/performance/example.json", {
      headers: { "accept-encoding": "gzip, br" },
    }),
    assets,
  );

  assert.equal(requestedPath, "/data/performance/example.json.gz");
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("content-encoding"), null);
  assert.match(response?.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), JSON.parse(payload));
});

test("falls through when no compressed asset exists", async () => {
  const response = await serveCompressedSiteData(
    new Request("https://example.com/data/performance/missing.json"),
    { async fetch() { return new Response("missing", { status: 404 }); } },
  );
  assert.equal(response, null);
});

test("does not intercept application or mutation requests", async () => {
  const assets = {
    async fetch() {
      throw new Error("asset lookup should not run");
    },
  };
  assert.equal(
    await serveCompressedSiteData(new Request("https://example.com/"), assets),
    null,
  );
  assert.equal(
    await serveCompressedSiteData(
      new Request("https://example.com/data/performance/example.json", { method: "POST" }),
      assets,
    ),
    null,
  );
});
