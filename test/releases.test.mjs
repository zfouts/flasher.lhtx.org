/**
 * The Worker may only ever proxy MeshCore release assets, so the validators
 * that gate every user-supplied path segment get the closest look.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseTag, isValidAssetName, upstreamAssetUrl, digestHex, summarizeReleases, routeApi,
} from '../src/releases.js';

test('release tags carry the firmware type and version', () => {
  assert.deepEqual(parseTag('repeater-v1.17.1'), { type: 'repeater', version: 'v1.17.1' });
  assert.deepEqual(parseTag('room-server-v1.17.1'), { type: 'room-server', version: 'v1.17.1' });
  assert.deepEqual(parseTag('companion-v1.9.0'), { type: 'companion', version: 'v1.9.0' });
  assert.equal(parseTag('v1.17.1'), null);
  assert.equal(parseTag('repeater-v1.17'), null);
  assert.equal(parseTag('repeater-v1.17.1/../x'), null);
});

test('only plausible firmware file names pass', () => {
  assert.ok(isValidAssetName('Heltec_v3_repeater-v1.17.1-d929643-merged.bin'));
  assert.ok(isValidAssetName('RAK_4631_repeater-v1.17.1-d929643.zip'));
  assert.ok(isValidAssetName('t1000e_companion_radio_ble-v1.17.1-d929643.uf2'));
  for (const bad of ['../x.bin', 'a/b.bin', '.bin', 'x.exe', 'x.bin.sh', '', 'x..bin', 'x.BIN']) {
    assert.equal(isValidAssetName(bad), false, `"${bad}" should be rejected`);
  }
});

test('upstream URLs point at the MeshCore release, and refuse anything else', () => {
  assert.equal(
    upstreamAssetUrl('repeater-v1.17.1', 'Heltec_v3_repeater-v1.17.1-d929643.bin'),
    'https://github.com/meshcore-dev/MeshCore/releases/download/repeater-v1.17.1/Heltec_v3_repeater-v1.17.1-d929643.bin',
  );
  assert.throws(() => upstreamAssetUrl('main', 'x.bin'));
  assert.throws(() => upstreamAssetUrl('repeater-v1.17.1', '../../x.bin'));
});

test('GitHub digests are normalised to bare lowercase hex, or null', () => {
  assert.equal(digestHex('sha256:' + 'AB'.repeat(32)), 'ab'.repeat(32));
  assert.equal(digestHex('md5:abc'), null);
  assert.equal(digestHex(undefined), null);
  assert.equal(digestHex('sha256:abc'), null);
});

test('summarizeReleases keeps stable firmware releases, newest first, with per-asset hashes', () => {
  const api = [
    { tag_name: 'repeater-v1.16.0', published_at: '2026-06-06T15:54:59Z', html_url: 'u16', body: 'old', assets: [] },
    { tag_name: 'v1.17.1', published_at: '2026-08-14T00:00:00Z', assets: [] },
    { tag_name: 'repeater-v1.18.0', prerelease: true, published_at: '2026-09-01T00:00:00Z', assets: [] },
    { tag_name: 'repeater-v1.17.1', draft: false, published_at: '2026-08-14T13:32:04Z', html_url: 'u17', body: ' notes ',
      assets: [
        { name: 'Heltec_v3_repeater-v1.17.1-d929643-merged.bin', size: 5, digest: 'sha256:' + 'a'.repeat(64) },
        { name: 'weird name.txt', size: 1 },
        { name: 'RAK_4631_repeater-v1.17.1-d929643.zip', size: 7 },
      ] },
  ];
  const out = summarizeReleases(api);
  assert.deepEqual(out.map((r) => r.tag), ['repeater-v1.17.1', 'repeater-v1.16.0']);
  const r = out[0];
  assert.equal(r.type, 'repeater');
  assert.equal(r.version, 'v1.17.1');
  assert.equal(r.notes, 'notes');
  assert.equal(r.url, 'u17');
  assert.deepEqual(r.assets.map((a) => a.name), [
    'Heltec_v3_repeater-v1.17.1-d929643-merged.bin',
    'RAK_4631_repeater-v1.17.1-d929643.zip',
  ]);
  assert.equal(r.assets[0].sha256, 'a'.repeat(64));
  assert.equal(r.assets[1].sha256, null, 'no digest → null, never a fake pass');
  assert.match(r.assets[0].upstream, /^https:\/\/github\.com\/meshcore-dev\/MeshCore\/releases\/download\/repeater-v1\.17\.1\//);
});

test('routeApi validates every segment and leaves non-API paths to the assets', () => {
  assert.equal(routeApi('/'), null);
  assert.equal(routeApi('/js/app.js'), null);
  assert.deepEqual(routeApi('/api/releases'), { kind: 'releases' });
  assert.deepEqual(routeApi('/api/boards'), { kind: 'boards' });
  assert.deepEqual(
    routeApi('/api/firmware/repeater-v1.17.1/Heltec_v3_repeater-v1.17.1-d929643.bin'),
    { kind: 'firmware', tag: 'repeater-v1.17.1', asset: 'Heltec_v3_repeater-v1.17.1-d929643.bin' },
  );
  assert.deepEqual(routeApi('/api/firmware/main/x.bin'), { kind: 'invalid' });
  assert.deepEqual(routeApi('/api/firmware/repeater-v1.17.1/%2e%2e%2fx.bin'), { kind: 'invalid' });
  assert.deepEqual(routeApi('/api/anything'), { kind: 'invalid' });
});
