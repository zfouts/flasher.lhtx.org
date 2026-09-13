/**
 * Regenerates public/boards.json, the offline fallback for the board list.
 *
 * The page normally gets the list live from flasher.meshcore.io through the
 * Worker (/api/boards). This file is only served when that fetch fails, and
 * the page says so. It is the same reduction of the flasher's config.json,
 * pinned to a commit so the fallback is reproducible.
 *
 *   node scripts/sync-boards.mjs            refresh at the pinned commit
 *   node scripts/sync-boards.mjs --latest   move the pin to the flasher's main
 *   node scripts/sync-boards.mjs --check    exit 1 if boards.json is stale
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FLASHER_REPO, reduceFlasherConfig } from '../src/boards.js';

export { ROLES, reduceFlasherConfig } from '../src/boards.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'public', 'boards.json');

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export async function syncBoards({ latest = false, check = false } = {}) {
  const current = readCurrent();
  let commit = current?.source?.commit;
  if (latest || !commit) {
    const head = await fetchJson(`https://api.github.com/repos/${FLASHER_REPO}/commits/main`, {
      headers: { accept: 'application/vnd.github+json' },
    });
    commit = head.sha;
  }

  const configUrl = `https://raw.githubusercontent.com/${FLASHER_REPO}/${commit}/config.json`;
  const config = await fetchJson(configUrl);
  const next = reduceFlasherConfig(config, {
    repo: FLASHER_REPO,
    commit,
    url: configUrl,
    // Stable across re-runs at the same commit, so --check is meaningful.
    syncedAt: current?.source?.commit === commit ? current.source.syncedAt : new Date().toISOString().slice(0, 10),
  });

  const text = `${JSON.stringify(next, null, 2)}\n`;
  const stale = text !== (current ? `${JSON.stringify(current, null, 2)}\n` : '');
  if (check) {
    if (stale) {
      console.error('public/boards.json is stale; run `npm run boards`');
      process.exit(1);
    }
    console.log('public/boards.json is current');
    return next;
  }
  writeFileSync(OUT, text);
  console.log(`public/boards.json: ${next.boards.length} boards from ${FLASHER_REPO}@${commit.slice(0, 7)}`);
  return next;
}

function readCurrent() {
  try {
    return JSON.parse(readFileSync(OUT, 'utf8'));
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncBoards({
    latest: process.argv.includes('--latest'),
    check: process.argv.includes('--check'),
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
