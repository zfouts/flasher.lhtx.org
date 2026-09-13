/**
 * Region scope: the optional `regions` list in config.json, and the CLI plan
 * built from it.
 *
 * A region is not a radio setting. It scopes what a repeater re-transmits:
 * traffic cascades top-down from a parent to its children and is blocked
 * bottom-up, so a wrong parent silently changes how far messages travel.
 * These names are also a namespace shared with neighbouring meshes, which is
 * why the shape is checked rather than trusted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateConfig } from '../public/js/profile.js';

const RAW = JSON.parse(readFileSync(new URL('../public/config.json', import.meta.url), 'utf8'));
const withRegions = (regions) => { const c = structuredClone(RAW); c.regions = regions; return c; };

const LHTX = [
  { name: 'us' },
  { name: 'us-south', parent: 'us' },
  { name: 'us-southcentral', parent: 'us-south' },
  { name: 'us-tx', parent: 'us-southcentral' },
  { name: 'us-tx-central', parent: 'us-tx' },
  { name: 'us-tx-aus', parent: 'us-tx-central' },
  { name: 'lhtx' },
];

test('the shipped config.json carries the Liberty Hill hierarchy', () => {
  const p = validateConfig(RAW);
  assert.deepEqual(p.regions.map((r) => r.name), LHTX.map((r) => r.name));
  assert.equal(p.regions.find((r) => r.name === 'us').parent, '');
  assert.equal(p.regions.find((r) => r.name === 'us-tx').parent, 'us-southcentral');
  assert.equal(p.regions.find((r) => r.name === 'lhtx').parent, '',
    'lhtx is standalone: local traffic must not leak up to the metro chain');
});

test('regions are optional; without them the feature is simply absent', () => {
  const c = structuredClone(RAW);
  delete c.regions;
  assert.deepEqual(validateConfig(c).regions, []);
});

test('a parent must be defined earlier in the list', () => {
  // region put needs the parent to exist already, so ordering is the check.
  assert.throws(
    () => validateConfig(withRegions([{ name: 'us-tx', parent: 'us' }, { name: 'us' }])),
    /regions\[0\].parent/,
  );
  assert.throws(
    () => validateConfig(withRegions([{ name: 'us' }, { name: 'us-tx', parent: 'nowhere' }])),
    /regions\[1\].parent/,
  );
});

test('a region cannot be its own parent', () => {
  assert.throws(() => validateConfig(withRegions([{ name: 'us', parent: 'us' }])), /regions\[0\].parent/);
});

test('duplicate names are rejected', () => {
  assert.throws(
    () => validateConfig(withRegions([{ name: 'us' }, { name: 'us' }])),
    /regions\[1\].name/,
  );
});

test('names are restricted to the lowercase form used over the air', () => {
  for (const bad of ['US', 'us tx', 'us_tx', 'us.tx', '-us', 'us-', '']) {
    assert.throws(
      () => validateConfig(withRegions([{ name: bad }])),
      /regions\[0\].name/,
      `${JSON.stringify(bad)} should be rejected`,
    );
  }
  for (const good of ['us', 'us-tx-aus', 'lhtx', 'nashmesh', 'us-tn-bna']) {
    assert.ok(validateConfig(withRegions([{ name: good }])), `${JSON.stringify(good)} should be accepted`);
  }
});

test('regions must be an array of objects', () => {
  assert.throws(() => validateConfig(withRegions('us')), /regions must be an array/);
  assert.throws(() => validateConfig(withRegions([null])), /regions\[0\]/);
});

// --- the plan --------------------------------------------------------------

const { planRepeater, runPlan } = await import('../public/js/configure.js');

const PROFILE = validateConfig(RAW);
const noop = () => {};
const device = { firmwareVersion: 'v1.14.1' };

/** A repeater that records region CLI calls; `supported: false` is old firmware. */
function fakeRepeater({ supported = true, existing = [] } = {}) {
  return {
    calls: [],
    async setName() {}, async setRadio() {}, async setTxPower() {}, async setPathHashMode() {},
    async setFloodAdvertInterval() {}, async setZeroHopAdvertInterval() {},
    async setGps() {}, async setAdvertLocationPolicy() {}, async setTime() {},
    async sendAdvert() {}, async reboot() {},
    async listRegions() {
      if (!supported) throw new Error('Unknown command');
      return existing;
    },
    async putRegion(name, parent) {
      if (!supported) throw new Error('Unknown command');
      this.calls.push(parent ? `put:${name} ${parent}` : `put:${name}`);
    },
    async saveRegions() {
      if (!supported) throw new Error('Unknown command');
      this.calls.push('save');
    },
  };
}

const regionStep = (steps) => steps.find((s) => s.label === 'Set region scope');
const plan = (radio, opts) => planRepeater(radio, { name: 'n', gps: false, device, profile: PROFILE, ...opts });

test('the region step is absent unless it is asked for', () => {
  assert.equal(regionStep(plan(fakeRepeater())), undefined,
    'opt-in: no region step without regions:true');
});

test('the region step is absent when config.json defines no regions', () => {
  const bare = validateConfig((() => { const c = structuredClone(RAW); delete c.regions; return c; })());
  assert.equal(regionStep(plan(fakeRepeater(), { profile: bare, regions: true })), undefined);
});

test('the plan puts every region in config order, parents first, then saves', async () => {
  const radio = fakeRepeater();
  await runPlan(plan(radio, { regions: true }), noop);
  assert.deepEqual(radio.calls, [
    'put:us',
    'put:us-south us',
    'put:us-southcentral us-south',
    'put:us-tx us-southcentral',
    'put:us-tx-central us-tx',
    'put:us-tx-aus us-tx-central',
    'put:lhtx',
    'save',
  ]);
});

test('firmware without region support skips the step instead of failing the run', async () => {
  const radio = fakeRepeater({ supported: false });
  const results = await runPlan(plan(radio, { regions: true }), noop);
  const step = results.find((r) => r.label === 'Set region scope');
  assert.equal(step.status, 'skipped');
  assert.ok(results.every((r) => r.status !== 'failed'), 'the rest of the run must still complete');
});

test('regions already on the repeater are reported, not silently overwritten', async () => {
  const radio = fakeRepeater({ existing: ['us-tn-bna', 'nashmesh'] });
  const results = await runPlan(plan(radio, { regions: true }), noop);
  const step = results.find((r) => r.label === 'Set region scope');
  assert.match(step.detail, /us-tn-bna/, 'the operator must be told what was already there');
  assert.match(step.detail, /nashmesh/);
});

test('the lines quoted on screen are the same strings sent to the radio', async () => {
  // Two places built "region put <name> <parent>" by hand; this is what stops
  // the preview promising something the plan does not do.
  const { regionPutLine } = await import('../public/js/repeater.js');
  const radio = fakeRepeater();
  await runPlan(plan(radio, { regions: true }), noop);

  const sent = radio.calls
    .filter((c) => c.startsWith('put:'))
    .map((c) => `region put ${c.slice('put:'.length)}`);
  assert.deepEqual(PROFILE.regions.map(regionPutLine), sent);
});
