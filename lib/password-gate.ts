const COOKIE_NAME = "__Host-spd_access";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;
const textEncoder = new TextEncoder();

export interface PasswordGateEnv {
  SITE_PASSWORD?: string;
  SITE_SESSION_SECRET?: string;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeReturnTo(value: FormDataEntryValue | null): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(value)),
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function passwordMatches(
  provided: string,
  expected: string,
  secret: string,
): Promise<boolean> {
  const [providedDigest, expectedDigest] = await Promise.all([
    hmac(secret, provided),
    hmac(secret, expected),
  ]);
  return equalBytes(providedDigest, expectedDigest);
}

async function expectedSession(secret: string): Promise<string> {
  return toHex(await hmac(secret, "satellite-productivity-detection:access"));
}

function passwordPage(returnTo: string, incorrect = false): Response {
  const safePath = escapeHtml(returnTo);
  const error = incorrect
    ? '<p class="error" role="alert">That password was not recognised. Please try again.</p>'
    : "";

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Private access · Satellite Productivity Detection</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #17251c; background: #e9eee8; }
    main { width: min(100%, 430px); padding: 36px; border: 1px solid #cbd5ca; border-radius: 18px; background: #fff; box-shadow: 0 22px 60px rgb(31 51 39 / 12%); }
    .eyebrow { margin: 0 0 12px; color: #55715f; font-size: 12px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(26px, 7vw, 36px); line-height: 1.06; letter-spacing: -.035em; }
    .intro { margin: 16px 0 24px; color: #526158; line-height: 1.55; }
    label { display: block; margin-bottom: 8px; font-size: 14px; font-weight: 700; }
    input { width: 100%; min-height: 48px; padding: 11px 13px; border: 1px solid #aebcaf; border-radius: 9px; font: inherit; }
    input:focus { outline: 3px solid rgb(46 112 70 / 22%); border-color: #2e7046; }
    button { width: 100%; min-height: 48px; margin-top: 14px; border: 0; border-radius: 9px; color: #fff; background: #245c39; font: inherit; font-weight: 750; cursor: pointer; }
    button:hover { background: #1c4a2e; }
    .error { margin: 0 0 16px; padding: 11px 12px; border-radius: 8px; color: #7d241d; background: #fff0ee; font-size: 14px; }
    .note { margin: 18px 0 0; color: #68756d; font-size: 12px; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Private farm analysis</p>
    <h1>Satellite Productivity Detection</h1>
    <p class="intro">Enter the shared password to open the application.</p>
    ${error}
    <form method="post" action="/_access">
      <input type="hidden" name="return_to" value="${safePath}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Open application</button>
    </form>
    <p class="note">Access remains valid on this device for 14 days.</p>
  </main>
</body>
</html>`,
    {
      status: incorrect ? 401 : 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    },
  );
}

function unavailableResponse(): Response {
  return new Response("Private access is not configured.", {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

export async function enforcePasswordAccess(
  request: Request,
  env: PasswordGateEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const password = env.SITE_PASSWORD;
  const sessionSecret = env.SITE_SESSION_SECRET;

  if (!password || !sessionSecret) {
    return isLocalHostname(url.hostname) ? null : unavailableResponse();
  }

  const expected = await expectedSession(sessionSecret);
  const session = readCookie(request, COOKIE_NAME);
  if (session && equalBytes(textEncoder.encode(session), textEncoder.encode(expected))) {
    if (url.pathname === "/_access") {
      return Response.redirect(new URL("/", url), 303);
    }
    return null;
  }

  const returnTo = `${url.pathname}${url.search}`;
  if (url.pathname === "/_access" && request.method === "POST") {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return passwordPage("/", true);
    }

    const provided = String(form.get("password") ?? "").slice(0, 256);
    const redirectTo = safeReturnTo(form.get("return_to"));
    if (await passwordMatches(provided, password, sessionSecret)) {
      return new Response(null, {
        status: 303,
        headers: {
          location: redirectTo,
          "set-cookie": `${COOKIE_NAME}=${expected}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
          "cache-control": "no-store",
        },
      });
    }
    return passwordPage(redirectTo, true);
  }

  if (url.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(request.method)) {
    return new Response(JSON.stringify({ error: "Password required" }), {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    });
  }

  return passwordPage(returnTo);
}
