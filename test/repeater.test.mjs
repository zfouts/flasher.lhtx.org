/**
 * The repeater CLI is plain text, so the exact strings matter and the reply
 * handling has to know what real firmware says. Reply strings below are
 * verbatim from CommonCLI.cpp.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { RepeaterClient } from '../public/js/repeater.js';

/** Fake MeshPort: scripted replies keyed by the exact command line. */
function fakePort(replies) {
  return {
    sent: [],
    cleared: 0,
    pending: null,
    clearAll() { this.cleared++; this.pending = null; },
    clearText() { this.pending = null; },
    async sendLine(line) {
      this.sent.push(line);
      this.pending = replies[line] ?? null; // null → no reply → timeout
    },
    takeCliReply() { const r = this.pending; this.pending = null; return r; },
  };
}

test('sends the exact CLI strings the firmware parses', async () => {
  const port = fakePort({
    'set name ATX-Hill': 'OK',
    'set radio 910.525,62.5,7,5': 'OK - reboot to apply',
    'set tx 22': 'OK',
    'set path.hash.mode 1': 'OK',
    'set flood.advert.interval 12': 'OK',
    'set advert.interval 60': 'OK',
    'gps on': 'ok',
    'gps advert share': 'ok',
    'time 1800000000': 'OK - clock set: 12:00 - 15/1/2027 UTC',
  });
  const c = new RepeaterClient(port);
  await c.setName('ATX-Hill');
  await c.setRadio({ freqMHz: 910.525, bwKHz: 62.5, sf: 7, cr: 5 });
  await c.setTxPower(22);
  await c.setPathHashMode(1);
  await c.setFloodAdvertInterval(12);
  await c.setZeroHopAdvertInterval(60);
  await c.setGps(true);
  await c.setAdvertLocationPolicy('share');
  await c.setTime(1800000000);
  assert.deepEqual(port.sent, [
    'set name ATX-Hill',
    'set radio 910.525,62.5,7,5',
    'set tx 22',
    'set path.hash.mode 1',
    'set flood.advert.interval 12',
    'set advert.interval 60',
    'gps on',
    'gps advert share',
    'time 1800000000',
  ]);
});

test('every OK-shaped reply the firmware emits counts as success', async () => {
  for (const reply of ['OK', 'ok', 'OK - reboot to apply', '(OK - stats reset)', 'OK - Advert sent']) {
    const c = new RepeaterClient(fakePort({ 'set tx 22': reply }));
    await assert.doesNotReject(() => c.setTxPower(22), `"${reply}" should be success`);
  }
});

test('every error shape the firmware emits is a thrown, labelled failure', async () => {
  const cases = [
    ['Error, bad chars', /Set node name: Error, bad chars/],
    ['(ERR: clock cannot go backwards)', /clock cannot go backwards/],
    ['Unknown command', /Unknown command/],
    ['Error, invalid radio params', /invalid radio params/],
    ['ERR: bad pubkey', /bad pubkey/],
  ];
  for (const [reply, expected] of cases) {
    const c = new RepeaterClient(fakePort({ 'set name x': reply }));
    await assert.rejects(() => c.setName('x'), expected, `"${reply}" should fail`);
  }
});

test('a board without GPS support is reported in plain words', async () => {
  for (const reply of ['gps toggle not found', 'Unknown command']) {
    const c = new RepeaterClient(fakePort({ 'gps on': reply }));
    await assert.rejects(() => c.setGps(true), /this board has no GPS receiver/);
  }
});

test('getRole insists on the "> value" shape so garbage is not accepted as a role', async () => {
  assert.equal(await new RepeaterClient(fakePort({ 'get role': '> repeater' })).getRole(), 'repeater');
  assert.equal(await new RepeaterClient(fakePort({ 'get role': '> room' })).getRole(), 'room');
  await assert.rejects(
    () => new RepeaterClient(fakePort({ 'get role': 'Unknown command' })).getRole(),
    /unexpected reply to "get role"/,
  );
});

test('flushLine tolerates silence and clears buffers before every command', async () => {
  const port = fakePort({}); // nothing answers
  const c = new RepeaterClient(port);
  await assert.doesNotReject(() => c.flushLine());
  assert.deepEqual(port.sent, [''], 'sends an empty line');
  assert.ok(port.cleared >= 1, 'buffers cleared so stale probe bytes cannot be misread');
});

test('a command that gets no reply times out with the command named', async () => {
  const c = new RepeaterClient(fakePort({}));
  await assert.rejects(() => c.send('set tx 22', { timeout: 60 }), /did not answer "set tx 22"/);
});
