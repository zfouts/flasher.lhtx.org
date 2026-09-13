/**
 * MeshPort feeds one byte stream to both a binary frame parser and a text
 * buffer, so the two must not trip over each other: the CLI prints '>'
 * (0x3e), which is also the frame start byte.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshPort } from '../public/js/port.js';

const text = (s) => new TextEncoder().encode(s);
const port = () => new MeshPort({});

test('outgoing frames get the 0x3c header and u16le length', async () => {
  const p = port();
  const written = [];
  p._write = async (b) => written.push([...b]);
  await p.sendFrame(Uint8Array.from([22, 10]));
  assert.deepEqual(written[0], [0x3c, 2, 0, 22, 10]);
});

test('a frame split across chunks is reassembled', () => {
  const p = port();
  p._ingest(Uint8Array.from([0x3e, 3]));
  assert.equal(p.takeFrame(), null);
  p._ingest(Uint8Array.from([0, 0]));
  assert.equal(p.takeFrame(), null);
  p._ingest(Uint8Array.from([1, 2]));
  assert.deepEqual([...p.takeFrame()], [0, 1, 2]);
});

test('garbage before a frame is skipped', () => {
  const p = port();
  p._ingest(Uint8Array.from([0xff, 0x00, 0x41, 0x3e, 1, 0, 13]));
  assert.deepEqual([...p.takeFrame()], [13]);
});

test('">" inside CLI text is never mistaken for a frame, and does not stall the parser', () => {
  const p = port();
  // "  -> > repeater\r\n": the "> " after the marker is 0x3e 0x20 0x72 → len 0x7220,
  // far over MAX_FRAME, so it must be rejected rather than waited on.
  p._ingest(text('  -> > repeater\r\n'));
  assert.equal(p.takeFrame(), null, 'no false frame');
  assert.equal(p.takeCliReply(), '> repeater', 'text side still works');

  // A real frame arriving afterwards must still parse, i.e. the parser did
  // not get stuck waiting for a bogus length.
  p._ingest(Uint8Array.from([0x3e, 2, 0, 0, 1]));
  assert.deepEqual([...p.takeFrame()], [0, 1]);
});

test('the binary scratch buffer stays bounded in CLI mode', () => {
  const p = port();
  // Header claiming 200 bytes that never arrive, then lots of CLI chatter.
  p._ingest(Uint8Array.from([0x3e, 200, 0]));
  for (let i = 0; i < 40; i++) p._ingest(text('  -> OK\r\n'.repeat(20)));
  assert.ok(p.binBuf.length <= 4096, `binBuf is ${p.binBuf.length}`);
});

test('CLI replies are extracted only when the full line has arrived', () => {
  const p = port();
  p._ingest(text('set name Foo\r\n  -> O'));
  assert.equal(p.takeCliReply(), null, 'partial line');
  p._ingest(text('K\r\n'));
  assert.equal(p.takeCliReply(), 'OK');
  assert.equal(p.takeCliReply(), null, 'drained');
});

test('the command echo is ignored; only the marked reply is returned', () => {
  const p = port();
  // Firmware echoes each typed byte before replying.
  p._ingest(text('get role\r\n  -> > repeater\r\n'));
  assert.equal(p.takeCliReply(), '> repeater');
});

// --- diagnostics ---------------------------------------------------------

test('everything received is counted and the first bytes sampled for diagnostics', () => {
  const p = port();
  assert.equal(p.rxBytes, 0);
  assert.equal(p.rxExcerpt(), '');
  p._ingest(text('ESP-ROM:esp32s3-20210327\r\nBuild:Mar 27 2021\r\n'));
  p._ingest(Uint8Array.from([0x3e, 1, 0, 13]));
  assert.equal(p.rxBytes, 49);
  assert.equal(p.rxExcerpt(), 'ESP-ROM:esp32s3-20210327 Build:Mar 27 2021 >�', 'line endings become spaces; binary bytes collapse to one marker');
});

test('the diagnostic sample is bounded and the excerpt truncated', () => {
  const p = port();
  for (let i = 0; i < 100; i++) p._ingest(text('x'.repeat(100)));
  assert.equal(p.rxBytes, 10000);
  assert.equal(p.rxSample.length, 512);
  assert.equal(p.rxExcerpt(50).length, 51, '50 chars plus an ellipsis');
});

test('usbId formats the vendor and product ids, and is empty for non-USB ports', () => {
  assert.equal(new MeshPort({ getInfo: () => ({ usbVendorId: 0x239a, usbProductId: 0x29 }) }).usbId(), '239a:0029');
  assert.equal(new MeshPort({ getInfo: () => ({}) }).usbId(), '');
  assert.equal(new MeshPort({}).usbId(), '');
});

test('settle returns at once when the board is silent, and waits out a boot log', async () => {
  const quietPort = port();
  let t = Date.now();
  assert.equal(await quietPort.settle({ initial: 100, quiet: 200, max: 1000 }), false);
  assert.ok(Date.now() - t < 300, 'did not wait for the quiet period');

  const booting = port();
  booting._ingest(text('ESP-ROM:esp32s3'));
  const chatter = setInterval(() => booting._ingest(text('boot line\r\n')), 30);
  setTimeout(() => clearInterval(chatter), 250);
  t = Date.now();
  assert.equal(await booting.settle({ initial: 100, quiet: 150, max: 2000 }), true);
  const waited = Date.now() - t;
  assert.ok(waited >= 350 && waited < 1000, `waited ${waited} ms: past the chatter plus the quiet period, well under max`);
});

test('settle gives up at max even if the line never goes quiet', async () => {
  const noisy = port();
  const chatter = setInterval(() => noisy._ingest(text('spam\r\n')), 20);
  const t = Date.now();
  assert.equal(await noisy.settle({ initial: 100, quiet: 200, max: 400 }), true);
  clearInterval(chatter);
  assert.ok(Date.now() - t < 700, 'capped at max');
});
