import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STEP, reachable, nearestReachable, downloadIsCurrent,
} from '../public/js/steps.js';

/* A state shaped like app.js's, with only the fields the gate reads. The
   asset object's identity is what ties a download to a choice, so these
   helpers hand out real distinct objects rather than reusing one. */
const asset = (name = 'firmware.zip') => ({ name, address: 0 });
const verified = (a) => ({ bytes: new Uint8Array(4), asset: a, verdict: { ok: true, status: 'match', reason: '' } });

const at = (over = {}) => ({
  board: { id: 'b', type: 'nrf52' }, roleKey: 'repeater', asset: null,
  download: null, client: null, configured: false, ...over,
});

test('the entry points open with nothing chosen at all', () => {
  const cold = at({ board: null, roleKey: '' });
  assert.equal(reachable(cold, STEP.radio), true);
  assert.equal(reachable(cold, STEP.connect), true, 'a radio already running MeshCore skips straight here');
});

test('review needs a board, a role and a picked asset', () => {
  const a = asset();
  assert.equal(reachable(at({ asset: a }), STEP.firmware), true);
  assert.equal(reachable(at({ asset: null }), STEP.firmware), false);
  assert.equal(reachable(at({ asset: a, board: null }), STEP.firmware), false);
  assert.equal(reachable(at({ asset: a, roleKey: '' }), STEP.firmware), false);
});

test('flashing opens only on a download that verified against its own asset', () => {
  const a = asset();
  assert.equal(reachable(at({ asset: a, download: verified(a) }), STEP.flash), true);
});

test('flashing stays shut on every unverified outcome', () => {
  const a = asset();
  for (const verdict of [
    { ok: false, status: 'mismatch', reason: 'bytes differ' },
    { ok: false, status: 'unverifiable', reason: 'GitHub published no SHA-256' },
  ]) {
    const state = at({ asset: a, download: { bytes: new Uint8Array(4), asset: a, verdict } });
    assert.equal(reachable(state, STEP.flash), false, `${verdict.status} must not open the flash step`);
  }
  assert.equal(reachable(at({ asset: a, download: null }), STEP.flash), false, 'no download at all');
});

/* The bug this file exists for: the verdict is an object, so comparing it to
   a string is always false and the flash step could never be reached. */
test('the verdict is an object, never the bare status string', () => {
  const a = asset();
  const state = at({ asset: a, download: verified(a) });
  assert.notEqual(state.download.verdict, 'match');
  assert.equal(state.download.verdict.status, 'match');
  assert.equal(reachable(state, STEP.flash), true);
});

/* The more dangerous bug: a verified download outliving the choice it was
   made for. Reachable through browser Back, change the board, Forward. */
test('a download stops counting once the choice it was made for changes', () => {
  const boardA = asset('board-a.zip');
  const done = at({ asset: boardA, download: verified(boardA) });
  assert.equal(reachable(done, STEP.flash), true);

  // What onRadioChoiceChanged() now does when the selection changes.
  const switched = { ...done, board: { id: 'other', type: 'esp32' }, asset: null, download: done.download };
  assert.equal(downloadIsCurrent(switched), false);
  assert.equal(reachable(switched, STEP.flash), false,
    'the previous board’s verified bytes must not arm the flash step');
  assert.equal(nearestReachable(switched, STEP.flash), STEP.radio,
    'and it falls back to the choice screen, not to a stale review');
});

test('a download made for a different asset never counts, even if both verified', () => {
  const a = asset('a.zip');
  const b = asset('b.zip');
  assert.equal(reachable(at({ asset: b, download: verified(a) }), STEP.flash), false);
});

test('configure and done need a live connection and a finished run', () => {
  assert.equal(reachable(at({ client: {} }), STEP.configure), true);
  assert.equal(reachable(at(), STEP.configure), false);
  assert.equal(reachable(at({ configured: true }), STEP.done), true);
  assert.equal(reachable(at(), STEP.done), false);
});

test('a deep link falls back to the furthest step the state supports', () => {
  assert.equal(nearestReachable(at({ board: null, roleKey: '' }), STEP.flash), STEP.radio,
    'cold load on #/flash lands on the choice screen');

  const a = asset();
  assert.equal(nearestReachable(at({ asset: a }), STEP.flash), STEP.firmware,
    'reviewed but not downloaded lands on the review screen');

  assert.equal(nearestReachable(at({ client: {} }), STEP.done), STEP.configure);
  assert.equal(nearestReachable(at(), STEP.connect), STEP.connect,
    'connect is always honored, it needs no prior state');
});

test('an unknown step is never reachable', () => {
  assert.equal(reachable(at(), 99), false);
  assert.equal(reachable(at(), undefined), false);
});
