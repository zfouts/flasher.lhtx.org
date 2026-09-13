import assert from 'node:assert/strict';
import test from 'node:test';
import { CompanionClient } from '../public/js/companion.js';
import { readFileSync } from 'node:fs';
import { validateConfig } from '../public/js/profile.js';

const PROFILE = validateConfig(JSON.parse(readFileSync(new URL('../public/config.json', import.meta.url), 'utf8')));

/** Transport that records what was sent and replies with a queued frame. */
function mockTransport(replies = []) {
  return {
    sent: [],
    queue: [...replies],
    async sendPayload(bytes) {
      this.sent.push(Uint8Array.from(bytes));
      const next = this.queue.shift();
      if (next) this.frame = Uint8Array.from(next);
    },
    takeFrame() { const f = this.frame; this.frame = null; return f ?? null; },
    clearFrames() { this.frame = null; },
  };
}

const OK = [0];

test('setRadio encodes freq in kHz and bandwidth in Hz, little-endian', async () => {
  const t = mockTransport([OK]);
  await new CompanionClient(t).setRadio(PROFILE.radio);
  const sent = t.sent[0];

  // firmware: freq/1000 -> MHz, bw/1000 -> kHz
  const view = new DataView(sent.buffer);
  assert.equal(sent[0], 11, 'CMD_SET_RADIO_PARAMS');
  assert.equal(view.getUint32(1, true), 910525, 'freq 910.525 MHz as kHz');
  assert.equal(view.getUint32(5, true), 62500, 'bw 62.5 kHz as Hz');
  assert.equal(sent[9], 7, 'SF7');
  assert.equal(sent[10], 5, 'CR5');
  assert.equal(sent.length, 11);

});

test('setTxPower and setPathHashMode encode correctly', async () => {
  const t = mockTransport([OK, OK]);
  const c = new CompanionClient(t);
  await c.setTxPower(22);
  await c.setPathHashMode(1);
  assert.deepEqual([...t.sent[0]], [12, 22]);
  assert.deepEqual([...t.sent[1]], [61, 0, 1], 'CMD_SET_PATH_HASH_MODE, reserved 0, mode 1');
});

test('setName and setGps encode as UTF-8 payloads', async () => {
  const t = mockTransport([OK, OK]);
  const c = new CompanionClient(t);
  await c.setName('ATX-Zilker-1');
  await c.setGps(true);
  assert.equal(t.sent[0][0], 8);
  assert.equal(new TextDecoder().decode(t.sent[0].subarray(1)), 'ATX-Zilker-1');
  assert.equal(t.sent[1][0], 41, 'CMD_SET_CUSTOM_VAR');
  assert.equal(new TextDecoder().decode(t.sent[1].subarray(1)), 'gps:1', 'name:value form');
});

test('ERR frame becomes a labelled error carrying the firmware code', async () => {
  const t = mockTransport([[1, 1]]); // ERR, ERR_CODE_UNSUPPORTED_CMD
  await assert.rejects(
    () => new CompanionClient(t).setPathHashMode(1),
    (e) => e.errorCode === 1 && /not supported/.test(e.message),
  );
});

test('deviceQuery parses the firmware DEVICE_INFO layout', async () => {
  // Built to match MyMesh.cpp: code, ver, maxcontacts/2, maxchannels,
  // ble_pin(4), build date(12), manufacturer(40), version(20), repeat, hash mode
  const f = new Uint8Array(82);
  f[0] = 13; f[1] = 10; f[2] = 50; f[3] = 8;
  new TextEncoder().encodeInto('7 Mar 2026', f.subarray(8, 20));
  new TextEncoder().encodeInto('Heltec V3', f.subarray(20, 60));
  new TextEncoder().encodeInto('v1.14.1', f.subarray(60, 80));
  f[80] = 0; f[81] = 1;

  const info = await new CompanionClient(mockTransport([f])).deviceQuery();
  assert.equal(info.protocolVersion, 10);
  assert.equal(info.firmwareBuildDate, '7 Mar 2026');
  assert.equal(info.manufacturer, 'Heltec V3');
  assert.equal(info.firmwareVersion, 'v1.14.1');
  assert.equal(info.pathHashMode, 1);
});

test('appStart parses the firmware SELF_INFO layout', async () => {
  const f = new Uint8Array(58 + 5);
  const v = new DataView(f.buffer);
  f[0] = 5; f[1] = 1; f[2] = 20; f[3] = 22;   // code, adv type, tx power, max tx power
  f[47] = 0;                                   // manual_add_contacts
  v.setUint32(48, 910525, true);               // freq (kHz)
  v.setUint32(52, 62500, true);                // bw (Hz)
  f[56] = 7; f[57] = 5;                        // sf, cr
  new TextEncoder().encodeInto('Node1', f.subarray(58));

  const self = await new CompanionClient(mockTransport([f])).appStart();
  assert.equal(self.maxTxPower, 22);
  assert.equal(self.radioFreqKHz, 910525);
  assert.equal(self.radioBw, 62500);
  assert.equal(self.radioSf, 7);
  assert.equal(self.radioCr, 5);
  assert.equal(self.name, 'Node1');
});

test('setAdvertLocationPolicy echoes the other SET_OTHER_PARAMS bytes from SELF_INFO', async () => {
  const t = mockTransport([OK]);
  await new CompanionClient(t).setAdvertLocationPolicy(1, { manualAddContacts: 1, telemetryModes: 0x15, multiAcks: 2 });
  // MyMesh.cpp: [38, manual_add_contacts, telemetry bits, advert_loc_policy, multi_acks]
  assert.deepEqual([...t.sent[0]], [38, 1, 0x15, 1, 2]);
});

test('firmware refusing to move the clock backwards is explained, not "illegal argument"', async () => {
  const t = mockTransport([[1, 6]]);
  await assert.rejects(() => new CompanionClient(t).setTime(1800000000), /clock is already ahead/);
});

test('a companion board without GPS is explained in plain words', async () => {
  const t = mockTransport([[1, 6]]);
  await assert.rejects(() => new CompanionClient(t).setGps(true), /this board has no GPS receiver/);
});

test('appStart exposes the telemetry byte needed to round-trip SET_OTHER_PARAMS', async () => {
  const f = new Uint8Array(63);
  f[0] = 5; f[44] = 2; f[45] = 0; f[46] = 0x15; f[47] = 1;
  const self = await new CompanionClient(mockTransport([f])).appStart();
  assert.equal(self.multiAcks, 2);
  assert.equal(self.telemetryModes, 0x15);
  assert.equal(self.manualAddContacts, 1);
});
