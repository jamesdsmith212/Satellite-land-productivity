import assert from "node:assert/strict";
import test from "node:test";

import { enforcePasswordAccess } from "../lib/password-gate.ts";

const env = {
  SITE_PASSWORD: "test-shared-password",
  SITE_SESSION_SECRET: "test-session-secret-that-is-long-enough",
};

test("local development remains available when hosted password secrets are absent", async () => {
  const response = await enforcePasswordAccess(
    new Request("http://127.0.0.1:3000/"),
    {},
  );
  assert.equal(response, null);
});

test("hosted access fails closed when password secrets are absent", async () => {
  const response = await enforcePasswordAccess(
    new Request("https://example.com/"),
    {},
  );
  assert.equal(response?.status, 503);
});

test("anonymous visitors receive the password screen", async () => {
  const response = await enforcePasswordAccess(
    new Request("https://example.com/records?year=2026"),
    env,
  );
  assert.equal(response?.status, 200);
  assert.match(await response.text(), /Enter the shared password/);
});

test("the correct password creates a secure session that grants access", async () => {
  const body = new URLSearchParams({
    password: env.SITE_PASSWORD,
    return_to: "/records?year=2026",
  });
  const login = await enforcePasswordAccess(
    new Request("https://example.com/_access", {
      method: "POST",
      body,
    }),
    env,
  );

  assert.equal(login?.status, 303);
  assert.equal(login?.headers.get("location"), "/records?year=2026");
  const setCookie = login?.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);

  const cookie = setCookie.split(";", 1)[0];
  const allowed = await enforcePasswordAccess(
    new Request("https://example.com/records", {
      headers: { cookie },
    }),
    env,
  );
  assert.equal(allowed, null);
});

test("an incorrect password is rejected without issuing a session", async () => {
  const response = await enforcePasswordAccess(
    new Request("https://example.com/_access", {
      method: "POST",
      body: new URLSearchParams({ password: "incorrect" }),
    }),
    env,
  );
  assert.equal(response?.status, 401);
  assert.equal(response?.headers.get("set-cookie"), null);
});

test("login redirects cannot leave the site", async () => {
  const response = await enforcePasswordAccess(
    new Request("https://example.com/_access", {
      method: "POST",
      body: new URLSearchParams({
        password: env.SITE_PASSWORD,
        return_to: "//malicious.example",
      }),
    }),
    env,
  );
  assert.equal(response?.headers.get("location"), "/");
});
