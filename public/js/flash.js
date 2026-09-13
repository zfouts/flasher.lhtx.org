/**
 * Writes verified firmware bytes to a radio over Web Serial.
 *
 *   ESP32  esptool-js (vendor/esptool-js, Apache-2.0). The loader pulses
 *          DTR/RTS to drop the chip into its ROM bootloader, so boards with a
 *          USB-UART bridge need no button; native-USB boards may need BOOT
 *          held while plugging in.
 *   nRF52  Nordic legacy serial DFU (vendor/dfu.js, MIT, from
 *          flasher.meshcore.io). The board must already be in its bootloader:
 *          either a double-tap of reset, or the 1200-baud "touch" in
 *          enterDfuMode(), after which it re-enumerates as a new port.
 *
 * Both follow flasher.meshcore.io's sequence exactly, same baud rates and the same
 * reset dance, because that is the path known to work on these boards.
 */

import { ESPLoader, Transport } from '../vendor/esptool-js/bundle.js';
import { Dfu } from '../vendor/dfu.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {SerialPort} o.port        an unopened Web Serial port
 * @param {Uint8Array} o.bytes       the image, already hash-verified
 * @param {number} o.address         0 for a merged image, 0x10000 for app-only
 * @param {boolean} o.eraseAll       wipe the whole flash first (fresh install)
 * @param {(written:number,total:number)=>void} o.onProgress
 * @param {(line:string)=>void} o.onLog   esptool's own chatter, for the log box
 * @returns {Promise<{chip:string}>}
 */
export async function flashEsp32({ port, bytes, address, eraseAll, onProgress = () => {}, onLog = () => {} }) {
  const transport = new Transport(port, false);
  const terminal = {
    clean() {},
    write: (s) => onLog(String(s)),
    writeLine: (s) => onLog(`${s}\n`),
  };
  const loader = new ESPLoader({
    transport,
    baudrate: 115200,
    romBaudrate: 115200,
    terminal,
    debugLogging: false,
  });

  let chip;
  try {
    chip = await loader.main();
    await loader.flashId();
  } catch (err) {
    await quietDisconnect(transport);
    throw new Error(
      `Couldn't reach the ESP32 bootloader (${err.message ?? err}). Unplug the radio, hold its BOOT button while plugging it back in, then try again.`,
    );
  }

  try {
    await loader.writeFlash({
      fileArray: [{ data: bytes, address }],
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll,
      compress: true,
      reportProgress: (_index, written, total) => onProgress(written, total),
    });
    await delay(100);
    await loader.after('hard_reset');
    await delay(100);
    // Belt and braces, as flasher.meshcore.io does: a second RTS pulse for
    // boards whose auto-reset circuit missed the first.
    await transport.setRTS(true);
    await delay(100);
    await transport.setRTS(false);
  } finally {
    await quietDisconnect(transport);
  }
  return { chip };
}

/**
 * The 1200-baud touch: open the port at 1200 baud, close it, and the
 * Adafruit-style bootloader reboots into DFU. The device then reappears as a
 * different serial port, so the caller must ask for the port again.
 */
export async function enterDfuMode(port) {
  await Dfu.forceDfuMode(port);
}

/**
 * @param {object} o
 * @param {SerialPort} o.port        the bootloader's port, unopened
 * @param {Uint8Array} o.zipBytes    the DFU package, already hash-verified
 * @param {(written:number,total:number)=>void} o.onProgress
 */
export async function flashNrf52({ port, zipBytes, onProgress = () => {} }) {
  const dfu = new Dfu(port);
  try {
    await dfu.dfuUpdate(zipBytes, (percent) => onProgress(percent, 100));
  } finally {
    try { await port.close(); } catch { /* the bootloader may already have rebooted */ }
  }
}

async function quietDisconnect(transport) {
  try { await transport.disconnect(); } catch { /* already gone */ }
}
