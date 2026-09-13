import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  pickAsset, releasesForRole, verifyDigest, sha256Hex, formatBytes, ESP32_APP_OFFSET,
} from '../public/js/firmware.js';

const BOARDS = JSON.parse(readFileSync(new URL('../public/boards.json', import.meta.url), 'utf8'));
const board = (name) => BOARDS.boards.find((b) => b.name === name);

const release = (tag, names) => ({
  tag,
  type: tag.replace(/-v.*$/, ''),
  version: tag.replace(/^.*-v/, 'v'),
  assets: names.map((name, i) => ({ name, size: 100 + i, sha256: 'c'.repeat(64), upstream: `https://github.com/meshcore-dev/MeshCore/releases/download/${tag}/${name}` })),
});

const REPEATER = release('repeater-v1.17.1', [
  'Heltec_v3_repeater-v1.17.1-d929643-merged.bin',
  'Heltec_v3_repeater-v1.17.1-d929643.bin',
  'RAK_4631_repeater-v1.17.1-d929643.uf2',
  'RAK_4631_repeater-v1.17.1-d929643.zip',
]);
const COMPANION = release('companion-v1.17.1', [
  'Heltec_v3_companion_radio_ble-v1.17.1-d929643-merged.bin',
  'Heltec_v3_companion_radio_usb-v1.17.1-d929643-merged.bin',
  'Heltec_v3_companion_radio_usb-v1.17.1-d929643.bin',
]);

test('ESP32 fresh install picks the merged image at 0x0; update picks the app image at 0x10000', () => {
  const fresh = pickAsset(board('Heltec v3'), 'repeater', REPEATER, { fresh: true });
  assert.equal(fresh.name, 'Heltec_v3_repeater-v1.17.1-d929643-merged.bin');
  assert.equal(fresh.address, 0);
  assert.equal(fresh.kind, 'flash-wipe');
  assert.equal(fresh.proxy, '/api/firmware/repeater-v1.17.1/Heltec_v3_repeater-v1.17.1-d929643-merged.bin');
  assert.match(fresh.upstream, /^https:\/\/github\.com\/meshcore-dev\/MeshCore\/releases\/download\//);

  const update = pickAsset(board('Heltec v3'), 'repeater', REPEATER, { fresh: false });
  assert.equal(update.name, 'Heltec_v3_repeater-v1.17.1-d929643.bin');
  assert.equal(update.address, ESP32_APP_OFFSET);
});

test('nRF52 always flashes the DFU zip, never the uf2', () => {
  const a = pickAsset(board('RAK WisBlock / WisMesh (RAK 4631)'), 'repeater', REPEATER, { fresh: true });
  assert.equal(a.name, 'RAK_4631_repeater-v1.17.1-d929643.zip');
  assert.equal(a.kind, 'flash');
});

test('companion USB and BLE map to different images', () => {
  assert.equal(pickAsset(board('Heltec v3'), 'companionUsb', COMPANION).name, 'Heltec_v3_companion_radio_usb-v1.17.1-d929643-merged.bin');
  assert.equal(pickAsset(board('Heltec v3'), 'companionBle', COMPANION).name, 'Heltec_v3_companion_radio_ble-v1.17.1-d929643-merged.bin');
});

test('no matching file → null, not a guess', () => {
  assert.equal(pickAsset(board('Heltec v3'), 'repeater', COMPANION), null);
  assert.equal(pickAsset(board('Heltec v3'), 'kissRadio', REPEATER), null);
  assert.equal(pickAsset(undefined, 'repeater', REPEATER), null);
});

test('releasesForRole filters by the release type the role is built from', () => {
  const all = [REPEATER, COMPANION, release('room-server-v1.17.1', [])];
  assert.deepEqual(releasesForRole(all, BOARDS.roles, 'companionUsb').map((r) => r.tag), ['companion-v1.17.1']);
  assert.deepEqual(releasesForRole(all, BOARDS.roles, 'roomServer').map((r) => r.tag), ['room-server-v1.17.1']);
  assert.deepEqual(releasesForRole(all, BOARDS.roles, 'nope'), []);
});

test('verifyDigest: match, mismatch, and unverifiable are three different answers', () => {
  assert.equal(verifyDigest('AB'.repeat(32), 'ab'.repeat(32)).status, 'match');
  const bad = verifyDigest('a'.repeat(64), 'b'.repeat(64));
  assert.equal(bad.status, 'mismatch');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /Nothing will be flashed/);
  const none = verifyDigest(null, 'b'.repeat(64));
  assert.equal(none.status, 'unverifiable');
  assert.equal(none.ok, false, 'a missing digest is never a pass');
});

test('sha256Hex matches the known test vector', async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(470343), '459 KB');
  assert.equal(formatBytes(1337376), '1.28 MB');
});
