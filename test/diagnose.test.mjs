/**
 * A failed detection must say what was on the wire, because the causes that
 * look identical to the app (bootloader, BLE-only companion build, wrong
 * firmware) need different fixes from the person holding the radio.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { explainNoAnswer } from '../public/js/diagnose.js';

test('total silence points at DFU mode and the BLE-only companion build', () => {
  const r = explainNoAnswer({ rxBytes: 0, excerpt: '', usbId: '239a:0029' });
  assert.match(r.message, /sent nothing at all/);
  assert.ok(r.hints.some((h) => /DFU/.test(h)), 'mentions DFU / bootloader mode');
  assert.ok(r.hints.some((h) => /Bluetooth companion firmware does not talk over USB/.test(h)));
  assert.match(r.detail, /USB id 239a:0029/);
  assert.match(r.detail, /0 bytes/);
});

test('unrecognised chatter quotes what arrived so it can be reported', () => {
  const r = explainNoAnswer({ rxBytes: 812, excerpt: 'ESP-ROM:esp32s3-20210327 Build:Mar 27 2021', usbId: '10c4:ea60' });
  assert.match(r.message, /sending data, but not anything this tool recognises/);
  assert.ok(r.hints.some((h) => /Meshtastic/.test(h)), 'names the common wrong firmware');
  assert.match(r.detail, /812 bytes/);
  assert.match(r.detail, /ESP-ROM:esp32s3/);
});

test('non-USB ports get no USB id in the detail', () => {
  const r = explainNoAnswer({ rxBytes: 0, excerpt: '', usbId: '' });
  assert.doesNotMatch(r.detail, /USB id/);
  assert.equal(r.detail, '0 bytes received');
});

test('defaults are safe when called with nothing', () => {
  const r = explainNoAnswer();
  assert.ok(r.message && Array.isArray(r.hints));
});
