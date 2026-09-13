/**
 * Cloudflare Worker in front of the static site.
 *
 * Once an hour (Cron Trigger, see wrangler.jsonc) `scheduled()` fetches two
 * lists and stores them in KV:
 *
 *   boards     flasher.meshcore.io/config.json, reduced    -> GET /api/boards
 *   releases   the meshcore-dev/MeshCore releases API,     -> GET /api/releases
 *              reduced, with GitHub's sha256 per asset
 *
 * Requests are answered from the stored copy, so visitors never wait on, or
 * get rate-limited by, GitHub. A failed refresh keeps the previous copy.
 * If the store is empty (first deploy) a request fetches on demand.
 *
 *   GET /api/firmware/<tag>/<asset>   one release asset, bytes untouched
 *
 * exists because github.com sends no CORS headers on downloads, so a
 * browser cannot fetch firmware from it directly. It is restricted to
 * meshcore-dev/MeshCore and edge-cached. Every route echoes its upstream in
 * X-Upstream-URL so the page can show exactly where the data came from, and
 * the page verifies the SHA-256 of what it receives against the digest
 * GitHub publishes, so a misbehaving relay (this one included) cannot go
 * unnoticed.
 *
 * Everything else is served from ./public by the assets binding.
 */

import { RELEASES_API, routeApi, summarizeReleases, upstreamAssetUrl } from './releases.js';
import { FLASHER_CONFIG_URL, reduceFlasherConfig } from './boards.js';

const FIRMWARE_TTL = 86400 * 7;      // a tagged asset never changes
const LIST_EDGE_TTL = 60;            // seconds a list answer may sit in the edge cache
const REFRESH_AFTER = 3 * 3600 * 1000; // a stored list older than this is refreshed on demand
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const USER_AGENT = 'flasher.lhtx.org (firmware wizard)';

const COMMON_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const LISTS = {
  boards: { upstream: FLASHER_CONFIG_URL, load: loadBoards },
  releases: { upstream: RELEASES_API, load: loadReleases },
};

export default {
  /** Cron Trigger: refresh both lists. One failing does not stop the other. */
  async scheduled(_event, env, _ctx) {
    const kinds = Object.keys(LISTS);
    const outcomes = await Promise.allSettled(kinds.map((kind) => refresh(kind, env)));
    outcomes.forEach((o, i) => {
      if (o.status === 'rejected') console.error(`refresh ${kinds[i]} failed: ${o.reason?.message}`);
    });
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = routeApi(url.pathname);
    if (route === null) return env.ASSETS.fetch(request);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return problem(405, 'Only GET is supported here.');
    }
    if (route.kind in LISTS) return serveList(route.kind, env, ctx);
    if (route.kind === 'firmware') return withEdgeCache(request, ctx, () => fetchFirmware(route));
    return problem(404, 'Not a firmware route. Only MeshCore release assets are served.');
  },
};

class UpstreamError extends Error {
  constructor(message, upstream) {
    super(message);
    this.upstream = upstream;
  }
}

function problem(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...COMMON_HEADERS },
  });
}

// --- the two stored lists ----------------------------------------------------

/** Fetches a list from its upstream and stores it. Throws UpstreamError. */
async function refresh(kind, env) {
  const body = await LISTS[kind].load();
  if (env.STORE) await env.STORE.put(kind, JSON.stringify(body));
  return body;
}

async function serveList(kind, env, ctx) {
  let body = env.STORE ? await env.STORE.get(kind, 'json') : null;

  if (!body) {
    // Empty store: first deploy, or KV not bound in a dev session.
    try {
      body = await refresh(kind, env);
    } catch (err) {
      return problem(502, err.message, { upstream: err.upstream ?? LISTS[kind].upstream });
    }
  } else if (Date.now() - Date.parse(body.fetchedAt) > REFRESH_AFTER) {
    // The cron should have replaced this by now; refresh in the background
    // and answer with what we have.
    ctx.waitUntil(refresh(kind, env).catch((err) => console.error(`refresh ${kind} failed: ${err.message}`)));
  }

  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${LIST_EDGE_TTL}`,
      'x-upstream-url': LISTS[kind].upstream,
      'x-fetched-at': body.fetchedAt,
      ...COMMON_HEADERS,
    },
  });
}

async function loadBoards() {
  const upstream = await fetch(FLASHER_CONFIG_URL, { headers: { 'user-agent': USER_AGENT } });
  if (!upstream.ok) {
    throw new UpstreamError(`flasher.meshcore.io answered HTTP ${upstream.status} for its board list.`, FLASHER_CONFIG_URL);
  }
  const fetchedAt = new Date().toISOString();
  return {
    ...reduceFlasherConfig(await upstream.json(), {
      url: FLASHER_CONFIG_URL,
      fetchedAt,
      // What the flasher's server says about the file, for the provenance line.
      lastModified: upstream.headers.get('last-modified') ?? '',
      etag: upstream.headers.get('etag') ?? '',
    }),
    fetchedAt,
  };
}

async function loadReleases() {
  const upstream = await fetch(RELEASES_API, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
    },
  });
  if (!upstream.ok) {
    let why = '';
    if (upstream.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(upstream.headers.get('x-ratelimit-reset')) * 1000;
      why = reset ? ` GitHub's rate limit is used up until ${new Date(reset).toISOString().slice(11, 16)} UTC.` : " GitHub's rate limit is used up.";
    }
    throw new UpstreamError(`GitHub answered HTTP ${upstream.status} for the releases list.${why}`, RELEASES_API);
  }
  return {
    source: RELEASES_API,
    fetchedAt: new Date().toISOString(),
    releases: summarizeReleases(await upstream.json()),
  };
}

// --- firmware relay ------------------------------------------------------------

/** Edge cache keyed by our own URL; a miss runs `produce` and stores a copy. */
async function withEdgeCache(request, ctx, produce) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  const response = await produce();
  if (response.ok) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

async function fetchFirmware({ tag, asset }) {
  const source = upstreamAssetUrl(tag, asset);
  const upstream = await fetch(source, { redirect: 'follow', headers: { 'user-agent': USER_AGENT } });
  if (!upstream.ok) {
    return problem(upstream.status === 404 ? 404 : 502,
      `GitHub answered HTTP ${upstream.status} for ${asset}.`, { upstream: source });
  }
  const length = Number(upstream.headers.get('content-length') ?? 0);
  if (length > MAX_ASSET_BYTES) {
    return problem(502, `${asset} is ${length} bytes, larger than any MeshCore image.`, { upstream: source });
  }

  const headers = {
    'content-type': 'application/octet-stream',
    'cache-control': `public, max-age=${FIRMWARE_TTL}, immutable`,
    'x-upstream-url': source,
    // The CDN host the redirect landed on, for anyone checking the trail.
    'x-upstream-final-url': upstream.url,
    ...COMMON_HEADERS,
  };
  if (length) headers['content-length'] = String(length);
  return new Response(upstream.body, { headers });
}
