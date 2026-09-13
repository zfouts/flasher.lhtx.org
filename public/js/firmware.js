/**
 * Firmware catalogue and download for the flash step.
 *
 * Three sources, each shown to the person on screen:
 *
 *   /api/boards      which boards exist and which release asset each role
 *                    maps to: flasher.meshcore.io's own config.json, which
 *                    the Worker refetches hourly and stores. boards.json is
 *                    the offline fallback, and is labelled as such when used.
 *   /api/releases    the meshcore-dev/MeshCore GitHub releases, refetched
 *                    hourly and stored by the Worker; carries GitHub's
 *                    published sha256 per asset
 *   /api/firmware/…  the asset bytes, proxied because github.com sends no
 *                    CORS headers; verified here against that sha256
 *
 * The pure functions are exported for tests; only loadBoards/loadReleases/
 * downloadFirmware touch the network.
 */

export const ESP32_APP_OFFSET = 0x10000;

export async function loadBoards(liveUrl = '/api/boards', fallbackUrl = '/boards.json') {
  try {
    const res = await fetch(liveUrl, { cache: 'no-cache' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return { ...body, live: true };
  } catch (liveError) {
    const res = await fetch(fallbackUrl, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Could not load the board list: ${liveError.message}; the fallback answered HTTP ${res.status}.`);
    return { ...(await res.json()), live: false, liveError: liveError.message };
  }
}

export async function loadReleases(url = '/api/releases') {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Could not load the firmware releases (HTTP ${res.status}).`);
  return body;
}

/** Releases of the type a role is built from, newest first. */
export function releasesForRole(releases, roles, roleKey) {
  const type = roles[roleKey]?.release;
  return (releases ?? []).filter((r) => r.type === type);
}

/**
 * The asset to flash for a board+role from one release, plus how to flash it.
 *
 *   esp32  fresh: the "-merged.bin" (bootloader + partitions + app) at 0x0,
 *                 which erases everything including the node identity
 *          update: the app-only ".bin" at 0x10000, keeping identity/contacts
 *   nrf52  always the DFU ".zip"; the bootloader writes only the app region
 *
 * Returns null when the release has no matching file for this board.
 */
export function pickAsset(board, roleKey, release, { fresh = true } = {}) {
  const files = board?.roles?.[roleKey]?.files;
  if (!files || !release) return null;

  let kind;
  let address = 0;
  if (board.type === 'esp32') {
    kind = fresh ? 'flash-wipe' : 'flash-update';
    address = fresh ? 0 : ESP32_APP_OFFSET;
  } else {
    kind = 'flash';
  }
  const pattern = files[kind];
  if (!pattern) return null;

  const re = new RegExp(pattern);
  const asset = release.assets.find((a) => re.test(a.name));
  if (!asset) return null;

  return {
    kind,
    address,
    name: asset.name,
    size: asset.size,
    sha256: asset.sha256,
    upstream: asset.upstream,
    proxy: `/api/firmware/${encodeURIComponent(release.tag)}/${encodeURIComponent(asset.name)}`,
    release,
  };
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compares what was downloaded with what GitHub published. `expected` may be
 * null when GitHub has no digest for an asset; that is reported as
 * unverifiable rather than as a pass.
 */
export function verifyDigest(expected, actual) {
  if (!expected) return { ok: false, status: 'unverifiable', reason: 'GitHub published no SHA-256 for this file.' };
  if (expected.toLowerCase() === actual.toLowerCase()) return { ok: true, status: 'match', reason: '' };
  return { ok: false, status: 'mismatch', reason: 'The bytes received do not match the SHA-256 GitHub published. Nothing will be flashed.' };
}

/**
 * Streams the asset, reporting progress, then hashes it. Resolves with the
 * bytes, the computed hash, the verdict, and the upstream URL the Worker
 * says it fetched.
 */
export async function downloadFirmware(asset, onProgress = () => {}) {
  const res = await fetch(asset.proxy);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Download failed (HTTP ${res.status}).`);
  }
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const bytes = concat(chunks, received);
  const sha256 = await sha256Hex(bytes);
  return {
    bytes,
    sha256,
    verdict: verifyDigest(asset.sha256, sha256),
    upstream: res.headers.get('x-upstream-url') ?? asset.upstream,
    finalUrl: res.headers.get('x-upstream-final-url') ?? '',
  };
}

function concat(chunks, length) {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
