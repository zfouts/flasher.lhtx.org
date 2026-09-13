/**
 * The Worker under a stubbed Cloudflare runtime: a fake KV store, a fake
 * edge cache, a fake assets binding, and a fake fetch that records what it
 * was asked for. Two properties matter: requests are answered from the
 * store, and it never fetches anything but the two known upstreams.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';

const RELEASES_URL = 'https://api.github.com/repos/meshcore-dev/MeshCore/releases?per_page=30';
const BOARDS_URL = 'https://flasher.meshcore.io/config.json';

const RELEASES_API = [{ tag_name: 'repeater-v1.17.1', published_at: '2026-08-14T13:32:04Z', assets: [
  { name: 'RAK_4631_repeater-v1.17.1-d929643.zip', size: 3, digest: 'sha256:' + 'b'.repeat(64) },
] }];
const FLASHER_CONFIG = { maker: { heltec: { name: 'Heltec' } }, device: [
  { maker: 'heltec', name: 'Heltec v3', type: 'esp32', firmware: [
    { class: 'community', role: 'repeater', github: { type: 'repeater', files: { 'flash-wipe': 'a-merged\\.bin', 'flash-update': 'a\\.bin' } } },
  ] },
] };

function okUpstream(url) {
  if (url === RELEASES_URL) return Response.json(RELEASES_API);
  if (url === BOARDS_URL) return Response.json(FLASHER_CONFIG, { headers: { 'last-modified': 'Wed, 09 Sep 2026 14:35:17 GMT' } });
  return new Response('', { status: 404 });
}

function harness({ upstream = okUpstream, kv = true } = {}) {
  const calls = [];
  const cacheStore = new Map();
  const kvStore = new Map();
  globalThis.caches = {
    default: {
      async match(req) { return cacheStore.get(req.url)?.clone() ?? undefined; },
      async put(req, res) { cacheStore.set(req.url, res); },
    },
  };
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return upstream(String(url), init); };
  const env = {
    ASSETS: { fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`) },
    ...(kv ? { STORE: {
      async get(key, type) { const v = kvStore.get(key); return v == null ? null : (type === 'json' ? JSON.parse(v) : v); },
      async put(key, value) { kvStore.set(key, value); },
    } } : {}),
  };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const run = (path, init) => worker.fetch(new Request(`https://config.example${path}`, init), env, ctx);
  const cron = () => worker.scheduled({ cron: '17 * * * *' }, env, ctx);
  return { run, cron, calls, kvStore, env, pending };
}

test('non-API paths go straight to the static assets', async () => {
  const h = harness();
  const res = await h.run('/js/app.js');
  assert.equal(await res.text(), 'asset:/js/app.js');
  assert.equal(h.calls.length, 0, 'no upstream fetch');
});

test('the cron fetches both lists and stores them', async () => {
  const h = harness();
  await h.cron();
  assert.deepEqual(h.calls.map((c) => c.url).sort(), [RELEASES_URL, BOARDS_URL].sort());
  const releases = JSON.parse(h.kvStore.get('releases'));
  assert.equal(releases.source, RELEASES_URL);
  assert.equal(releases.releases[0].assets[0].sha256, 'b'.repeat(64));
  const boards = JSON.parse(h.kvStore.get('boards'));
  assert.equal(boards.source.url, BOARDS_URL);
  assert.equal(boards.source.lastModified, 'Wed, 09 Sep 2026 14:35:17 GMT');
  assert.deepEqual(boards.boards.map((b) => b.id), ['heltec-v3']);
  assert.match(boards.fetchedAt, /^\d{4}-/);
});

test('requests are answered from the store without touching upstream', async () => {
  const h = harness();
  await h.cron();
  const before = h.calls.length;
  const res = await h.run('/api/releases');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-upstream-url'), RELEASES_URL);
  assert.match(res.headers.get('x-fetched-at'), /^\d{4}-/);
  assert.equal((await res.json()).releases[0].tag, 'repeater-v1.17.1');
  const boards = await h.run('/api/boards');
  assert.equal(boards.status, 200);
  assert.equal((await boards.json()).boards[0].name, 'Heltec v3');
  assert.equal(h.calls.length, before, 'no upstream fetch on request');
});

test('an empty store fetches on demand and fills itself', async () => {
  const h = harness();
  const res = await h.run('/api/boards');
  assert.equal(res.status, 200);
  assert.equal(h.calls.length, 1);
  assert.ok(h.kvStore.has('boards'));
  await h.run('/api/boards');
  assert.equal(h.calls.length, 1, 'second request served from the store');
});

test('a failed refresh keeps the previous copy, and the request still succeeds', async () => {
  let fail = false;
  const h = harness({
    upstream: (url) => fail
      ? new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789055520' } })
      : okUpstream(url),
  });
  await h.cron();
  fail = true;
  await h.cron(); // GitHub refuses this time
  assert.equal(JSON.parse(h.kvStore.get('releases')).releases[0].tag, 'repeater-v1.17.1', 'old copy kept');
  assert.equal((await h.run('/api/releases')).status, 200);
});

test('a stored copy older than three hours is served now and refreshed in the background', async () => {
  const h = harness();
  await h.cron();
  const old = JSON.parse(h.kvStore.get('releases'));
  old.fetchedAt = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  h.kvStore.set('releases', JSON.stringify(old));
  const before = h.calls.length;
  const res = await h.run('/api/releases');
  assert.equal(res.status, 200);
  await Promise.all(h.pending);
  assert.equal(h.calls.length, before + 1, 'one background refresh');
  assert.ok(Date.parse(JSON.parse(h.kvStore.get('releases')).fetchedAt) > Date.parse(old.fetchedAt));
});

test('with nothing stored and GitHub rate-limiting, the error says so with the reset time', async () => {
  const h = harness({
    upstream: () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789055520' } }),
  });
  const res = await h.run('/api/releases');
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /HTTP 403/);
  assert.match(body.error, /rate limit is used up until \d\d:\d\d UTC/);
  assert.equal(body.upstream, RELEASES_URL);
});

test('without a KV binding (local dev) lists are fetched per request', async () => {
  const h = harness({ kv: false });
  assert.equal((await h.run('/api/boards')).status, 200);
  assert.equal((await h.run('/api/boards')).status, 200);
  assert.equal(h.calls.length, 2);
});

test('the firmware route proxies exactly one MeshCore release asset, bytes untouched', async () => {
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const h = harness({
    upstream: (url) => {
      const res = new Response(bytes, { headers: { 'content-length': '4', 'content-type': 'text/html' } });
      Object.defineProperty(res, 'url', { value: url.replace('github.com', 'release-assets.githubusercontent.com') });
      return res;
    },
  });
  const res = await h.run('/api/firmware/repeater-v1.17.1/RAK_4631_repeater-v1.17.1-d929643.zip');
  assert.equal(res.status, 200);
  assert.equal(h.calls[0].url, 'https://github.com/meshcore-dev/MeshCore/releases/download/repeater-v1.17.1/RAK_4631_repeater-v1.17.1-d929643.zip');
  assert.equal(res.headers.get('x-upstream-url'), h.calls[0].url);
  assert.match(res.headers.get('x-upstream-final-url'), /release-assets\.githubusercontent\.com/);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream', 'never trusts the upstream type');
  assert.equal(res.headers.get('content-length'), '4');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3, 4]);
  await h.run('/api/firmware/repeater-v1.17.1/RAK_4631_repeater-v1.17.1-d929643.zip');
  assert.equal(h.calls.length, 1, 'second fetch served from the edge cache');
});

test('invalid tags, invalid names, other methods and other API paths are refused without any upstream fetch', async () => {
  const h = harness();
  assert.equal((await h.run('/api/firmware/main/x.bin')).status, 404);
  assert.equal((await h.run('/api/firmware/repeater-v1.17.1/..%2Fx.bin')).status, 404);
  assert.equal((await h.run('/api/other')).status, 404);
  assert.equal((await h.run('/api/releases', { method: 'POST' })).status, 405);
  assert.equal(h.calls.length, 0);
});

test('an asset the upstream cannot serve is reported with the URL that failed', async () => {
  const h = harness({ upstream: () => new Response('', { status: 503 }) });
  const res = await h.run('/api/firmware/repeater-v1.17.1/RAK_4631_repeater-v1.17.1-d929643.zip');
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /HTTP 503/);
  assert.match(body.upstream, /^https:\/\/github\.com\//);
});
