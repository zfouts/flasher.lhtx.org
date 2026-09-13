/**
 * End-to-end run of both configuration plans against a simulated radio that
 * mimics the firmware's validation, so a bad command shows up as a failed
 * step rather than silently succeeding.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { planCompanion, planRepeater, runPlan } from '../public/js/configure.js';
import { validateConfig } from '../public/js/profile.js';

// Exercise the plans against the real shipped config, not a fixture, so a bad
// edit to config.json fails here too.
const PROFILE = validateConfig(JSON.parse(readFileSync(new URL('../public/config.json', import.meta.url), 'utf8')));

/** Records every call and validates arguments the way the firmware does. */
function fakeCompanion({ maxTxPower = 22, hasGps = true } = {}) {
  return {
    calls: [],
    log(name, arg) { this.calls.push(arg === undefined ? name : `${name}:${arg}`); },
    async setName(n) { this.log('name', n); },
    async setRadio({ freqMHz, bwKHz, sf, cr }) {
      assert.ok(freqMHz * 1000 >= 150000 && freqMHz * 1000 <= 2500000);
      assert.ok(bwKHz * 1000 >= 7000 && bwKHz * 1000 <= 500000);
      assert.ok(sf >= 5 && sf <= 12 && cr >= 5 && cr <= 8);
      this.log('radio', `${freqMHz},${bwKHz},${sf},${cr}`);
    },
    async setTxPower(p) {
      if (p > maxTxPower) throw new Error('illegal argument');
      this.log('tx', p);
    },
    async setPathHashMode(m) { assert.ok(m < 3); this.log('hash', m); },
    async setGps(on) {
      if (!hasGps) throw new Error('gps toggle not found');
      this.log('gps', on ? 1 : 0);
    },
    async setAdvertLocationPolicy(policy) { this.log('loc', policy); },
    async setTime(t) { assert.ok(t > 1_700_000_000); this.log('time'); },
    async sendFloodAdvert() { this.log('advert'); },
  };
}

function fakeRepeater({ hasGps = true } = {}) {
  const base = fakeCompanion({ hasGps });
  return Object.assign(base, {
    async setFloodAdvertInterval(h) {
      assert.ok(h >= 3 && h <= 168, `flood interval ${h} outside firmware range 3-168`);
      base.log('flood', h);
    },
    async setZeroHopAdvertInterval(m) {
      assert.ok(m >= 60 && m <= 240, `zero-hop interval ${m} outside firmware range 60-240`);
      base.log('zerohop', m);
    },
    async sendAdvert() { base.log('advert'); },
    async reboot() { base.log('reboot'); },
  });
}

const noop = () => {};
const device = { firmwareVersion: 'v1.14.1' };

test('step labels come from config.json, not hard-coded region names', async () => {
  const steps = planCompanion(fakeCompanion(), { name: 'x', gps: false, device, selfInfo: {}, profile: PROFILE });
  assert.ok(steps.some((s) => s.label === `Apply ${PROFILE.label} radio settings`));
  assert.ok(steps.some((s) => s.label === `Use ${PROFILE.pathHashMode + 1}-byte path hashes`));
});

test('companion plan writes every recommended setting', async () => {
  const radio = fakeCompanion();
  const results = await runPlan(
    planCompanion(radio, { name: 'ATX-1', gps: true, device, selfInfo: { maxTxPower: 22 }, profile: PROFILE }),
    noop,
  );

  const { freqMHz, bwKHz, sf, cr } = PROFILE.radio;
  assert.deepEqual(radio.calls, [
    'name:ATX-1', `radio:${freqMHz},${bwKHz},${sf},${cr}`,
    `tx:${PROFILE.txPowerDbm}`, `hash:${PROFILE.pathHashMode}`,
    'gps:1', 'loc:1', // receiver on, then ADVERT_LOC_SHARE, both needed for the map
    'time', 'advert',
  ]);
  assert.ok(results.every((r) => r.status === 'done'), 'no step failed or was skipped');
});

test('repeater plan adds the advert intervals and reboots, without a doomed pre-reboot advert', async () => {
  const radio = fakeRepeater();
  const results = await runPlan(planRepeater(radio, { name: 'ATX-Hill', gps: false, device, profile: PROFILE }), noop);

  const { freqMHz, bwKHz, sf, cr } = PROFILE.radio;
  assert.deepEqual(radio.calls, [
    'name:ATX-Hill', `radio:${freqMHz},${bwKHz},${sf},${cr}`,
    `tx:${PROFILE.txPowerDbm}`, `hash:${PROFILE.pathHashMode}`,
    `flood:${PROFILE.floodAdvertHours}`, `zerohop:${PROFILE.zeroHopAdvertMinutes}`,
    'gps:0', 'time', 'reboot',
  ], 'no advert: it would be queued 1.5 s out and discarded by the reboot; no loc policy change when GPS is off');
  assert.ok(results.every((r) => r.status === 'done'));
});

test('a board without GPS is reported, not fatal', async () => {
  const radio = fakeCompanion({ hasGps: false });
  const results = await runPlan(
    planCompanion(radio, { name: 'ATX-1', gps: true, device, selfInfo: { maxTxPower: 22 }, profile: PROFILE }),
    noop,
  );

  const gps = results.find((r) => /GPS receiver/.test(r.label));
  assert.equal(gps.status, 'skipped');
  assert.match(gps.detail, /gps toggle not found/);

  // Crucially, sharing must NOT be enabled: with no receiver the "live fix"
  // is 0,0 and the node would appear off the coast of West Africa.
  const share = results.find((r) => /Share position/.test(r.label));
  assert.equal(share.status, 'skipped');
  assert.match(share.detail, /receiver could not be turned on/);
  assert.ok(!radio.calls.some((c) => c.startsWith('loc')), 'loc policy never sent');

  assert.ok(results.some((r) => r.label === 'Announce to the mesh' && r.status === 'done'),
    'the run continues past skipped optional steps');
});

test('transmit power clamps to what the board supports', async () => {
  const radio = fakeCompanion({ maxTxPower: 17 });
  const results = await runPlan(
    planCompanion(radio, { name: 'ATX-1', gps: false, device, selfInfo: { maxTxPower: 17 }, profile: PROFILE }),
    noop,
  );
  assert.ok(radio.calls.includes('tx:17'), 'clamped to the board maximum');
  assert.match(results.find((r) => /transmit/i.test(r.label)).detail, /board's maximum/);
});

test('firmware too old for 2-byte paths is skipped with an explanation', async () => {
  const radio = fakeCompanion();
  const results = await runPlan(
    planCompanion(radio, {
      name: 'ATX-1', gps: false,
      device: { firmwareVersion: 'v1.13.0' },
      selfInfo: { maxTxPower: 22 },
      profile: PROFILE,
    }),
    noop,
  );

  const hash = results.find((r) => /path hashes/.test(r.label));
  assert.equal(hash.status, 'skipped');
  assert.match(hash.detail, /1\.14\.0 or newer/);
  assert.ok(!radio.calls.some((c) => c.startsWith('hash')), 'never sent to old firmware');
});

test('a failing required step aborts the run', async () => {
  const radio = fakeCompanion();
  radio.setRadio = async () => { throw new Error('invalid radio params'); };
  await assert.rejects(
    () => runPlan(planCompanion(radio, { name: 'x', gps: false, device, selfInfo: {}, profile: PROFILE }), noop),
    new RegExp(`Apply ${PROFILE.label.replace(/[()\/]/g, '\\$&')} radio settings failed: invalid radio params`),
  );
  assert.ok(!radio.calls.includes('tx:22'), 'stops before later steps');
});
