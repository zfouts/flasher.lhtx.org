/**
 * Regenerates the settings table in README.md from public/config.json, so the
 * documented values cannot drift from the ones actually sent to radios.
 *
 *   node scripts/sync-readme.mjs          rewrite README.md
 *   node scripts/sync-readme.mjs --check  exit 1 if README.md is stale
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateConfig } from '../public/js/profile.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN = '<!-- BEGIN GENERATED SETTINGS -->';
const END = '<!-- END GENERATED SETTINGS -->';

export function renderTable(profile) {
  const rows = [
    ['Region preset', `${profile.label}: ${profile.summary}`],
    ['Transmit power', `${profile.txPowerDbm} dBm (clamped to the board's maximum)`],
    ['Path hashes', profile.pathHashMode === 1
      ? '2-byte (`path.hash.mode 1`)'
      : `\`path.hash.mode ${profile.pathHashMode}\``],
    ['Node name', 'yours'],
    ['GPS', 'your choice; on also sets `advert_loc_policy` to share the live fix, so the node appears on the map; off leaves position sharing untouched'],
    ['Clock', 'synced from the browser'],
    ['Flood advert interval', `every ${profile.floodAdvertHours} hours *(repeaters only)*`],
    ['Zero-hop advert interval', `every ${profile.zeroHopAdvertMinutes} minutes *(repeaters only)*`],
  ];

  return [
    BEGIN,
    '<!-- Generated from public/config.json by `npm run docs`. Do not edit by hand. -->',
    '',
    '| Setting | Value |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    END,
  ].join('\n');
}

export function syncReadme({ check = false } = {}) {
  const profile = validateConfig(JSON.parse(readFileSync(join(root, 'public/config.json'), 'utf8')));
  const readmePath = join(root, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');

  const start = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(`README.md is missing the ${BEGIN} / ${END} markers`);
  }

  const updated = readme.slice(0, start) + renderTable(profile) + readme.slice(end + END.length);
  if (updated === readme) return { changed: false };
  if (check) return { changed: true };

  writeFileSync(readmePath, updated);
  return { changed: true };
}

// Only act when run directly, so tests can import the helpers.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const { changed } = syncReadme({ check });
  if (check && changed) {
    console.error('README.md is out of date with public/config.json. Run: npm run docs');
    process.exit(1);
  }
  console.log(changed ? 'README.md updated from public/config.json' : 'README.md already up to date');
}
