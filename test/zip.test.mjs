/**
 * The zip reader only has to handle what nRF52 DFU packages contain, but it
 * must handle both stored and deflated entries and refuse what it cannot
 * read rather than hand the bootloader garbage.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { readZip } from '../public/js/zip.js';

/** Minimal zip writer: local headers, central directory, EOCD. No CRC. */
function makeZip(files, { comment = '' } = {}) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

  for (const { name, data, deflate } of files) {
    const nameBytes = enc.encode(name);
    const payload = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const local = Uint8Array.from([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(0), ...u32(payload.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ]);
    central.push(Uint8Array.from([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(0), ...u32(payload.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes,
    ]));
    parts.push(local, payload);
    offset += local.length + payload.length;
  }
  const dirStart = offset;
  const dirLen = central.reduce((n, c) => n + c.length, 0);
  const commentBytes = enc.encode(comment);
  const eocd = Uint8Array.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(dirLen), ...u32(dirStart), ...u16(commentBytes.length), ...commentBytes,
  ]);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

const text = (s) => new TextEncoder().encode(s);

test('reads stored and deflated entries, like a DFU package', async () => {
  const bin = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff);
  const zip = makeZip([
    { name: 'manifest.json', data: text('{"manifest":{"application":{"bin_file":"firmware.bin","dat_file":"firmware.dat"}}}') },
    { name: 'firmware.dat', data: Uint8Array.from([1, 2, 3]) },
    { name: 'firmware.bin', data: bin, deflate: true },
  ]);
  const entries = await readZip(zip);
  assert.deepEqual([...entries.keys()], ['manifest.json', 'firmware.dat', 'firmware.bin']);
  assert.equal(JSON.parse(new TextDecoder().decode(entries.get('manifest.json'))).manifest.application.bin_file, 'firmware.bin');
  assert.deepEqual([...entries.get('firmware.dat')], [1, 2, 3]);
  assert.deepEqual(entries.get('firmware.bin'), bin);
});

test('finds the end record behind an archive comment', async () => {
  const zip = makeZip([{ name: 'a.txt', data: text('hi') }], { comment: 'built by ci ' .repeat(20) });
  assert.equal(new TextDecoder().decode((await readZip(zip)).get('a.txt')), 'hi');
});

test('refuses non-zip input and unsupported methods', async () => {
  await assert.rejects(() => readZip(text('this is not a zip')), /not a zip/);
  const zip = makeZip([{ name: 'x', data: text('x') }]);
  // Flip the method in both headers to 99 (bzip2 etc.).
  const bad = Uint8Array.from(zip);
  bad[8] = 99;
  const centralAt = bad.length - 22 - (46 + 1);
  bad[centralAt + 10] = 99;
  await assert.rejects(() => readZip(bad), /method 99/);
});
