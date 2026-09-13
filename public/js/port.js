/**
 * USB serial transport for MeshCore radios.
 *
 * A single MeshCore device speaks exactly one of two protocols over USB,
 * depending on which firmware was flashed:
 *
 *   Companion  -> binary frames  (0x3c out / 0x3e in, u16le length)
 *   Repeater   -> a line-oriented text CLI, replies prefixed "  -> "
 *   Room server
 *
 * There is no handshake that identifies which, so this class owns the read
 * loop and feeds every incoming chunk to *both* a frame parser and a text
 * buffer. `detect()` then probes for one and falls back to the other.
 *
 * Text CLI response framing follows meshcore-dev/config.meshcore.io
 * (lib/serial-cli.js, MIT, (c) Rastislav Vysoky).
 */

const BAUD = 115200;
const FRAME_OUT = 0x3c; // '<'
const FRAME_IN = 0x3e;  // '>'
const CLI_MARKER = '  -> ';

// Firmware MAX_FRAME_SIZE is 176 (BaseSerialInterface.h). Anything claiming to
// be longer is CLI text that happens to contain '>', not a frame, and the CLI
// does print '>' (e.g. "  -> > repeater"). Rejecting it early stops the parser
// waiting on kilobytes that will never arrive.
const MAX_FRAME = 256;
// Bound on bytes retained while hunting for a frame start.
const MAX_BINBUF = 4096;
// How much of what the radio first sent is kept for diagnostics.
const RX_SAMPLE = 512;

export class MeshPort {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.closing = false;

    this.binBuf = [];      // raw bytes, scanned for 0x3e frames
    this.frames = [];      // completed binary payloads awaiting a consumer
    this.textBuf = '';     // decoded text, scanned for "  -> " replies

    this.decoder = new TextDecoder();
    this.onDisconnect = () => {};

    // Diagnostics: everything the radio has sent, counted and sampled, so a
    // failed detection can say *what* arrived rather than just "nothing
    // recognisable". Bootloaders and BLE-only firmware send nothing at all;
    // a rebooting ESP32 sends its ROM banner; both look the same otherwise.
    this.rxBytes = 0;
    this.rxSample = [];   // first RX_SAMPLE bytes ever received
    this.lastRxAt = 0;    // Date.now() of the most recent chunk
  }

  static supported() {
    return typeof navigator !== 'undefined'
      && !!navigator.serial
      && typeof navigator.serial.requestPort === 'function';
  }

  /** USB vendor/product id as "239a:8029", or '' for non-USB ports. */
  usbId() {
    const info = this.port.getInfo?.() ?? {};
    if (info.usbVendorId == null) return '';
    const hex = (n) => (n ?? 0).toString(16).padStart(4, '0');
    return `${hex(info.usbVendorId)}:${hex(info.usbProductId)}`;
  }

  /**
   * Waits for a board that resets when the port opens to finish booting.
   *
   * ESP32 boards with a USB-UART bridge reset on DTR and print a ROM banner
   * and boot log before the firmware is listening; probing during that is
   * wasted. If nothing arrives in the first `initial` ms the board did not
   * reset and this returns at once. Otherwise it returns once the line has
   * been silent for `quiet` ms, or after `max` ms regardless.
   */
  async settle({ initial = 400, quiet = 500, max = 8000 } = {}) {
    const started = Date.now();
    const tick = () => new Promise((r) => setTimeout(r, 50));
    while (Date.now() - started < initial && this.rxBytes === 0) await tick();
    if (this.rxBytes === 0) return false;
    while (Date.now() - started < max && Date.now() - this.lastRxAt < quiet) await tick();
    return true;
  }

  /** Printable rendering of the first bytes received, for error messages. */
  rxExcerpt(limit = 120) {
    const text = new TextDecoder().decode(Uint8Array.from(this.rxSample))
      .replace(/[^\x20-\x7e\r\n]/g, '\ufffd')  // control/binary bytes -> one marker each
      .replace(/\ufffd{2,}/g, '\ufffd')          // collapse runs of them
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  /** Prompts the user to pick a port. Must be called from a user gesture. */
  static async request() {
    if (!MeshPort.supported()) {
      throw new Error('This browser has no Web Serial support. Use Chrome, Edge or Opera on desktop.');
    }
    const port = await navigator.serial.requestPort({ filters: [] });
    return new MeshPort(port);
  }

  async open() {
    await this.port.open({ baudRate: BAUD });
    this.port.addEventListener('disconnect', () => this.onDisconnect());
    this._readLoop();
  }

  async close() {
    this.closing = true;
    try { await this.reader?.cancel(); } catch { /* already gone */ }
    try { await this.port.close(); } catch { /* already gone */ }
  }

  async _readLoop() {
    try {
      this.reader = this.port.readable.getReader();
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this._ingest(value);
      }
    } catch (err) {
      if (!this.closing) console.warn('serial read loop ended', err);
    } finally {
      try { this.reader?.releaseLock(); } catch { /* ignore */ }
      if (!this.closing) this.onDisconnect();
    }
  }

  _ingest(chunk) {
    this.rxBytes += chunk.length;
    this.lastRxAt = Date.now();
    if (this.rxSample.length < RX_SAMPLE) {
      for (const b of chunk.subarray(0, RX_SAMPLE - this.rxSample.length)) this.rxSample.push(b);
    }

    // Text view. The CLI is ASCII, so decoding binary frames here is harmless
    // noise that no CLI matcher will ever match.
    this.textBuf += this.decoder.decode(chunk, { stream: true });
    if (this.textBuf.length > 64 * 1024) this.textBuf = this.textBuf.slice(-16384);

    // Binary view.
    for (const b of chunk) this.binBuf.push(b);
    this._drainFrames();
  }

  _drainFrames() {
    const buf = this.binBuf;
    let i = 0;
    for (;;) {
      // Resync to the next plausible frame start.
      while (i < buf.length && buf[i] !== FRAME_IN) i++;
      if (buf.length - i < 3) break;

      const len = buf[i + 1] | (buf[i + 2] << 8);
      if (len === 0 || len > MAX_FRAME) { i++; continue; }
      if (buf.length - i < 3 + len) break; // wait for the rest

      this.frames.push(Uint8Array.from(buf.slice(i + 3, i + 3 + len)));
      i += 3 + len;
    }
    // Drop everything consumed or rejected in one splice rather than shifting
    // byte by byte; keep only a bounded tail if nothing is parseable.
    const keep = buf.slice(i);
    this.binBuf = keep.length > MAX_BINBUF ? keep.slice(-MAX_BINBUF) : keep;
  }

  async _write(bytes) {
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(Uint8Array.from(bytes));
    } finally {
      writer.releaseLock();
    }
  }

  // --- binary (companion) -------------------------------------------------

  /** Wraps a companion payload in a serial frame header and writes it. */
  async sendFrame(payload) {
    const len = payload.length;
    await this._write([FRAME_OUT, len & 0xff, (len >> 8) & 0xff, ...payload]);
  }

  takeFrame() {
    return this.frames.shift() ?? null;
  }

  clearFrames() {
    this.frames = [];
    this.binBuf = [];
  }

  /** Drops both views. Used when switching from probing to committed mode. */
  clearAll() {
    this.clearFrames();
    this.clearText();
  }

  // --- text (repeater / room server CLI) ----------------------------------

  async sendLine(line) {
    await this._write([...new TextEncoder().encode(line + '\r\n')]);
  }

  clearText() {
    this.textBuf = '';
  }

  /**
   * Pulls the next complete "  -> <reply>\r\n" out of the text buffer,
   * or null if one has not arrived yet.
   */
  takeCliReply() {
    const start = this.textBuf.indexOf(CLI_MARKER);
    if (start === -1) return null;
    const from = start + CLI_MARKER.length;
    const end = this.textBuf.indexOf('\r\n', from);
    if (end === -1) return null;
    const reply = this.textBuf.slice(from, end).trim();
    this.textBuf = this.textBuf.slice(end + 2);
    return reply;
  }
}
