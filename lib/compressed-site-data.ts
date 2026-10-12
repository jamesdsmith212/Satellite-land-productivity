export interface SiteAssetsBinding {
  fetch(request: Request): Promise<Response>;
}

const COMPRESSIBLE_DATA_PATH = /\.(?:geo)?json$/;

export async function serveCompressedSiteData(
  request: Request,
  assets: SiteAssetsBinding,
): Promise<Response | null> {
  if (!["GET", "HEAD"].includes(request.method)) return null;

  const url = new URL(request.url);
  if (!url.pathname.startsWith("/data/") || !COMPRESSIBLE_DATA_PATH.test(url.pathname)) {
    return null;
  }

  const compressedUrl = new URL(url);
  compressedUrl.pathname = `${url.pathname}.gz`;
  const compressedResponse = await assets.fetch(
    new Request(compressedUrl, {
      method: request.method,
    }),
  );
  if (!compressedResponse.ok) return null;

  const headers = new Headers(compressedResponse.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set(
    "content-type",
    url.pathname.endsWith(".geojson")
      ? "application/geo+json; charset=utf-8"
      : "application/json; charset=utf-8",
  );
  headers.set("cache-control", "private, max-age=86400");
  headers.set("vary", "Cookie, Accept-Encoding");

  const decodedBody = compressedResponse.body?.pipeThrough(
    new DecompressionStream("gzip"),
  );

  return new Response(request.method === "HEAD" ? null : decodedBody, {
    status: 200,
    headers,
  });
}
