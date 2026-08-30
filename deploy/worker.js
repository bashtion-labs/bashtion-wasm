// bashtion-wasm — Cloudflare Worker that serves the three large VM assets from
// a PRIVATE R2 bucket, and hands everything else to Workers Static Assets.
//
// Security posture (see deploy/README.md for the whole picture):
//   * The R2 bucket is private. It is reachable ONLY through this Worker's
//     bucket binding — there is no public bucket and no r2.dev URL.
//   * This Worker serves a fixed ALLOWLIST of keys. The request path is never
//     used as an R2 key, so there is no path traversal into the bucket.
//   * GET/HEAD only. Everything else is 405.
//   * Errors are generic — no bucket name, key, or internal detail leaks.
//   * Responses carry nosniff + same-origin CORP + long immutable cache.
// The large files are same-origin subresources, so they need no COOP/COEP or
// CORS; the cross-origin-isolation headers live on the HTML (deploy/_headers).
//
// Edge caching: a full GET for one of these files is served from Cloudflare's
// edge cache when possible, so repeat visitors don't re-read R2 (cuts Worker
// invocations and R2 Class B operations). Only full GETs are cached — ranged
// requests (rare; emscripten fetches these as a single full GET) go straight to
// R2 — and only objects under CACHE_MAX_BYTES are stored, which keeps the
// ~874 MiB rootfs (over the free-plan cache limit anyway) from being streamed
// through the Worker's 128 MiB memory.

// path -> { R2 object key, content-type }. Only these three paths are served
// from R2; every other path falls through to static assets.
const R2_FILES = {
  '/qemu-system-x86_64.wasm': { key: 'qemu-system-x86_64.wasm', type: 'application/wasm' },
  '/load-rootfsB.data':       { key: 'load-rootfsB.data',       type: 'application/octet-stream' },
  '/load-state.data':         { key: 'load-state.data',         type: 'application/octet-stream' },
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'cache-control': 'public, max-age=31536000, immutable',
};

// Don't put objects larger than this in the edge cache: it is above the
// free-plan max cacheable object size, and skipping it avoids teeing a huge
// body through the Worker. Such files still serve fine, just uncached.
const CACHE_MAX_BYTES = 512 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    const spec = R2_FILES[new URL(request.url).pathname];

    // Anything not on the allowlist is a static asset (page, JS, small data).
    if (!spec) return env.ASSETS.fetch(request);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD' },
      });
    }

    const rangeHeader = request.headers.get('range');

    // Ranged and HEAD requests bypass the edge cache and read R2 directly.
    if (rangeHeader || request.method === 'HEAD') {
      return serveFromR2(request, env, spec, rangeHeader);
    }

    // Full GET: try the edge cache first. Normalise the key to the URL so
    // client headers can't fragment the cache.
    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const object = await env.BUCKET.get(spec.key);
    if (!object) return new Response('Not Found', { status: 404 });

    const headers = new Headers(SECURITY_HEADERS);
    object.writeHttpMetadata(headers); // etag, last-modified
    headers.set('content-type', spec.type);
    headers.set('accept-ranges', 'bytes');
    headers.set('content-length', String(object.size));

    const response = new Response(object.body, { status: 200, headers });

    // Store a copy at the edge (best-effort). Skip oversized objects; swallow
    // any cache error so it never affects the response already being served.
    if (object.size <= CACHE_MAX_BYTES) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
    }
    return response;
  },
};

// Direct R2 read with Range / conditional / HEAD support (uncached path).
async function serveFromR2(request, env, spec, rangeHeader) {
  const range = rangeHeader ? parseRange(rangeHeader) : undefined;
  if (rangeHeader && !range) {
    return new Response('Range Not Satisfiable', { status: 416 });
  }

  const object = await env.BUCKET.get(spec.key, {
    range,
    onlyIf: request.headers, // enables 304 via If-None-Match / If-Modified-Since
  });

  // Missing object -> generic 404 (do not echo the key).
  if (!object) return new Response('Not Found', { status: 404 });

  const headers = new Headers(SECURITY_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set('content-type', spec.type);
  headers.set('accept-ranges', 'bytes');

  // Precondition matched (304): no body.
  if (!('body' in object) || object.body === undefined) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') {
    headers.set('content-length', String(object.size));
    return new Response(null, { status: 200, headers });
  }

  let status = 200;
  if (range && object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? (object.size - offset);
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    status = 206;
  }
  return new Response(object.body, { status, headers });
}

// "bytes=START-END" (either end optional) -> R2 range option, or null if malformed.
function parseRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === '' && e === '') return null;
  if (s === '') return { suffix: Number(e) };            // final N bytes
  const offset = Number(s);
  if (e === '') return { offset };                        // from offset to end
  return { offset, length: Number(e) - offset + 1 };
}
