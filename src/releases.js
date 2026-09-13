/**
 * Pure helpers shared by the Worker and its tests: which GitHub releases and
 * assets this site is willing to proxy, and how the releases API is reduced
 * to what the page needs.
 *
 * Everything the page flashes comes from one place, GitHub releases of
 * meshcore-dev/MeshCore, the same repository flasher.meshcore.io serves, and
 * the Worker refuses to fetch anything else, so it cannot be turned into a
 * general-purpose proxy.
 */

export const FIRMWARE_REPO = 'meshcore-dev/MeshCore';
export const RELEASES_API = `https://api.github.com/repos/${FIRMWARE_REPO}/releases?per_page=30`;

/** Release tags look like "repeater-v1.17.1"; the prefix is the firmware type. */
export const TAG_RE = /^(companion|repeater|room-server)-v(\d+\.\d+\.\d+)$/;
/** Asset names are board_role-version-hash[.-merged].{bin,zip,uf2}. Nothing else is fetched. */
export const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,150}\.(bin|zip|uf2)$/;

export function parseTag(tag) {
  const m = TAG_RE.exec(String(tag));
  return m ? { type: m[1], version: `v${m[2]}` } : null;
}

export function isValidAssetName(name) {
  return ASSET_RE.test(String(name)) && !name.includes('..');
}

/** The github.com URL the bytes really come from. Shown on screen, verbatim. */
export function upstreamAssetUrl(tag, asset) {
  if (!parseTag(tag) || !isValidAssetName(asset)) throw new Error('not a MeshCore release asset');
  return `https://github.com/${FIRMWARE_REPO}/releases/download/${tag}/${asset}`;
}

/** "sha256:abc…" from the GitHub API → "abc…", or null if absent/odd. */
export function digestHex(digest) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(digest ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Reduces the GitHub releases API payload to what the page shows and needs:
 * tag, type, version, date, link, notes, and per asset the name, size,
 * published sha256 and upstream URL. Drafts, prereleases and tags outside the
 * three firmware types are dropped. Newest first.
 */
export function summarizeReleases(apiReleases) {
  const out = [];
  for (const r of Array.isArray(apiReleases) ? apiReleases : []) {
    const parsed = parseTag(r?.tag_name);
    if (!parsed || r.draft || r.prerelease) continue;
    out.push({
      tag: r.tag_name,
      type: parsed.type,
      version: parsed.version,
      publishedAt: r.published_at ?? null,
      url: r.html_url ?? `https://github.com/${FIRMWARE_REPO}/releases/tag/${r.tag_name}`,
      notes: String(r.body ?? '').trim().slice(0, 4000),
      assets: (r.assets ?? [])
        .filter((a) => isValidAssetName(a?.name))
        .map((a) => ({
          name: a.name,
          size: a.size ?? null,
          sha256: digestHex(a.digest),
          upstream: upstreamAssetUrl(r.tag_name, a.name),
        })),
    });
  }
  return out.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

/**
 * Maps a request path to a Worker route, validating every user-supplied
 * segment. Returns null for anything that should fall through to the static
 * assets.
 */
export function routeApi(pathname) {
  if (pathname === '/api/releases') return { kind: 'releases' };
  if (pathname === '/api/boards') return { kind: 'boards' };
  const m = /^\/api\/firmware\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (m) {
    const tag = decodeURIComponent(m[1]);
    const asset = decodeURIComponent(m[2]);
    if (parseTag(tag) && isValidAssetName(asset)) return { kind: 'firmware', tag, asset };
    return { kind: 'invalid' };
  }
  if (pathname.startsWith('/api/')) return { kind: 'invalid' };
  return null;
}
