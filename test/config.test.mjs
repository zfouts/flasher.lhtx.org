/**
 * Guards public/config.json, the file people are meant to edit.
 *
 * A value the firmware rejects should fail here, loudly and by name, rather
 * than at 2am on a rooftop with a repeater that won't take its settings.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateConfig } from '../public/js/profile.js';
import { syncReadme } from '../scripts/sync-readme.mjs';

const RAW = JSON.parse(readFileSync(new URL('../public/config.json', import.meta.url), 'utf8'));
const clone = (mutate) => { const c = structuredClone(RAW); mutate(c); return c; };

test('the shipped config.json is valid', () => {
  const p = validateConfig(RAW);
  assert.equal(typeof p.label, 'string');
  assert.ok(p.radio.freqMHz > 0);
  assert.equal(p.network.name, 'Liberty Hill Mesh');
});

test('the summary is derived from the values, so it cannot drift', () => {
  const p = validateConfig(clone((c) => {
    c.preset.frequencyMHz = 869.618;
    c.preset.bandwidthKHz = 250;
    c.preset.spreadingFactor = 11;
    c.preset.codingRate = 8;
  }));
  assert.equal(p.summary, '869.618 MHz · SF11 · BW250 · CR8');
});

test('values outside the firmware ranges are rejected by name', () => {
  const cases = [
    ['preset.frequencyMHz', (c) => { c.preset.frequencyMHz = 3000; }],
    ['preset.bandwidthKHz', (c) => { c.preset.bandwidthKHz = 900; }],
    ['preset.spreadingFactor', (c) => { c.preset.spreadingFactor = 13; }],
    ['preset.codingRate', (c) => { c.preset.codingRate = 9; }],
    ['txPowerDbm', (c) => { c.txPowerDbm = 30; }],
    ['pathHashMode', (c) => { c.pathHashMode = 3; }],
    // Firmware: "interval range is 3-168 hours"
    ['repeater.floodAdvertHours', (c) => { c.repeater.floodAdvertHours = 2; }],
    // Firmware: MIN_LOCAL_ADVERT_INTERVAL is 60
    ['repeater.zeroHopAdvertMinutes', (c) => { c.repeater.zeroHopAdvertMinutes = 30; }],
  ];

  for (const [field, mutate] of cases) {
    assert.throws(
      () => validateConfig(clone(mutate)),
      (err) => err.message.includes(field),
      `${field} out of range should be rejected and named`,
    );
  }
});

test('missing and malformed fields are reported, not silently defaulted', () => {
  assert.throws(() => validateConfig(clone((c) => { delete c.preset; })), /missing preset/);
  assert.throws(() => validateConfig(clone((c) => { delete c.txPowerDbm; })), /missing txPowerDbm/);
  assert.throws(() => validateConfig(clone((c) => { c.preset.spreadingFactor = 7.5; })), /whole number/);
  assert.throws(() => validateConfig(clone((c) => { c.preset.frequencyMHz = '910.525'; })), /must be a number/);
  assert.throws(() => validateConfig(clone((c) => { c.preset.label = '  '; })), /non-empty string/);
});

test('strings, URLs and region entries are validated too', () => {
  assert.throws(() => validateConfig(clone((c) => { c.network.name = ''; })), /network\.name must be a non-empty string/);
  assert.throws(() => validateConfig(clone((c) => { c.network.site = 'javascript:alert(1)'; })), /network\.site must be an http\(s\) URL/);
  assert.throws(() => validateConfig(clone((c) => { c.network.guide = 'lhtx.org'; })), /network\.guide must be an http\(s\) URL/);
  assert.throws(() => validateConfig(clone((c) => { c.otherRegions.push({ label: 'X' }); })), /otherRegions\[4\]\.summary/);
  assert.throws(() => validateConfig(clone((c) => { c.otherRegions = 'nope'; })), /otherRegions must be an array/);
  assert.throws(() => validateConfig(clone((c) => { c.minFirmwareForPathHash = 'latest'; })), /minFirmwareForPathHash must look like/);
  // Optional URLs may be omitted.
  assert.doesNotThrow(() => validateConfig(clone((c) => { delete c.network.site; delete c.network.guide; })));
});

test('frequency and bandwidth must be whole kHz / Hz so both firmware paths get the same value', () => {
  // Companion path rounds to kHz on the wire; CLI path sends the decimal verbatim.
  assert.throws(() => validateConfig(clone((c) => { c.preset.frequencyMHz = 910.5255; })), /whole number of kHz/);
  assert.throws(() => validateConfig(clone((c) => { c.preset.bandwidthKHz = 62.5005; })), /whole number of Hz/);
  assert.doesNotThrow(() => validateConfig(clone((c) => { c.preset.frequencyMHz = 910.525; c.preset.bandwidthKHz = 62.5; })));
});

test('README.md is in sync with config.json', () => {
  const { changed } = syncReadme({ check: true });
  assert.equal(changed, false, 'README.md is stale; run `npm run docs`');
});
