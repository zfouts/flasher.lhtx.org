/**
 * A small ZIP reader, enough for nRF52 DFU packages, which hold three
 * files (manifest.json, firmware.bin, firmware.dat) stored or deflated.
 *
 * Uses the browser's own DecompressionStream for deflate, so no compression
 * library is shipped. Zip64, encryption and multi-disk archives are refused
 * rather than misread. Per-entry CRCs are not checked here because the whole
 * archive has already been verified against its published SHA-256 before it
 * reaches this code.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** @returns {Promise<Map<string, Uint8Array>>} entry name → contents */
export async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd === -1) throw new Error('not a zip file (no end-of-central-directory record)');

  const disk = view.getUint16(eocd + 4, true);
  const count = view.getUint16(eocd + 10, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || count === 0xffff || dirOffset === 0xffffffff) {
    throw new Error('zip64 or multi-part archives are not supported');
  }

  const entries = new Map();
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) throw new Error('corrupt zip: bad central directory entry');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error(`${name}: encrypted entries are not supported`);
    if (name.endsWith('/')) continue; // directory

    if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error(`${name}: bad local header`);
    const dataStart = localOffset + 30
      + view.getUint16(localOffset + 26, true)
      + view.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === METHOD_STORED) data = raw;
    else if (method === METHOD_DEFLATE) data = await inflate(raw);
    else throw new Error(`${name}: compression method ${method} is not supported`);
    if (data.length !== size) throw new Error(`${name}: expected ${size} bytes, got ${data.length}`);
    entries.set(name, data);
  }
  return entries;
}

function findEocd(view) {
  // The record is 22 bytes plus an optional comment of up to 64 KiB.
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

async function inflate(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
