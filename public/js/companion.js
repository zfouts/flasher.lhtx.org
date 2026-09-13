/**
 * MeshCore companion-firmware client (binary frame protocol).
 *
 * Command codes and byte layouts are taken from the firmware itself
 * (MeshCore/examples/companion_radio/MyMesh.cpp) rather than from
 * meshcore.js, which lags the firmware and is missing SET_PATH_HASH_MODE.
 *
 * Works over any transport exposing sendPayload/takeFrame/clearFrames:
 * USB serial (MeshPort) or Web Bluetooth (BleTransport).
 */

export const CMD = {
  APP_START: 1,
  SET_DEVICE_TIME: 6,
  SEND_SELF_ADVERT: 7,
  SET_ADVERT_NAME: 8,
  SET_RADIO_PARAMS: 11,
  SET_RADIO_TX_POWER: 12,
  REBOOT: 19,
  DEVICE_QUERY: 22,
  SET_CUSTOM_VAR: 41,
  SET_OTHER_PARAMS: 38,
  SET_PATH_HASH_MODE: 61,
};

export const RESP = {
  OK: 0,
  ERR: 1,
  SELF_INFO: 5,
  DEVICE_INFO: 13,
};

/** advert_loc_policy values (CommonCLI.h). */
export const ADVERT_LOC = { NONE: 0, SHARE: 1, PREFS: 2 };

const ERR_TEXT = {
  1: 'command not supported by this firmware',
  2: 'not found',
  3: 'table full',
  4: 'bad state',
  5: 'file I/O error',
  6: 'illegal argument',
};

// Highest companion protocol version this app knows how to talk.
const APP_PROTOCOL_VERSION = 10;

const isPush = (code) => code >= 0x80;

function cstr(bytes, offset, length) {
  const slice = bytes.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end)).trim();
}

export class CompanionClient {
  constructor(transport) {
    this.transport = transport;
  }

  /** Sends a payload and waits for the next non-push response frame. */
  async request(payload, { timeout = 5000 } = {}) {
    this.transport.clearFrames();
    await this.transport.sendPayload(Uint8Array.from(payload));

    const deadline = Date.now() + timeout;
    for (;;) {
      const frame = this.transport.takeFrame();
      if (frame && frame.length) {
        if (isPush(frame[0])) continue; // adverts etc. arrive unsolicited
        return frame;
      }
      if (Date.now() > deadline) throw new Error('The radio did not respond in time.');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Sends a payload that is expected to answer OK, and throws on ERR. */
  async command(payload, label) {
    const frame = await this.request(payload);
    if (frame[0] === RESP.OK) return;
    if (frame[0] === RESP.ERR) {
      const reason = ERR_TEXT[frame[1]] ?? `error code ${frame[1]}`;
      const err = new Error(`${label}: ${reason}`);
      err.errorCode = frame[1];
      throw err;
    }
    throw new Error(`${label}: unexpected response 0x${frame[0].toString(16)}`);
  }

  /** Identifies the device. Also the probe used to detect companion firmware. */
  async deviceQuery({ timeout = 1200 } = {}) {
    const frame = await this.request([CMD.DEVICE_QUERY, APP_PROTOCOL_VERSION], { timeout });
    if (frame[0] !== RESP.DEVICE_INFO) {
      throw new Error('Not companion firmware.');
    }
    const info = {
      protocolVersion: frame[1],
      firmwareBuildDate: cstr(frame, 8, 12),
      manufacturer: cstr(frame, 20, 40),
      firmwareVersion: cstr(frame, 60, 20),
      // Only meaningful on the protocol versions that emit them.
      repeatEnabled: frame.length > 80 ? frame[80] === 1 : null,
      pathHashMode: frame.length > 81 ? frame[81] : null,
    };
    return info;
  }

  /** Starts an app session; the reply carries the device's current settings. */
  async appStart(appName = 'LibertyHill') {
    const name = new TextEncoder().encode(appName);
    const frame = await this.request([CMD.APP_START, 1, 0, 0, 0, 0, 0, 0, ...name]);
    if (frame[0] !== RESP.SELF_INFO) {
      throw new Error('Radio did not return its current settings.');
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    return {
      advertType: frame[1],
      txPower: frame[2],
      maxTxPower: frame[3],
      publicKey: [...frame.subarray(4, 36)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      multiAcks: frame[44],
      advertLocPolicy: frame[45],
      telemetryModes: frame[46],
      manualAddContacts: frame[47],
      radioFreqKHz: view.getUint32(48, true),
      radioBw: view.getUint32(52, true),
      radioSf: frame[56],
      radioCr: frame[57],
      name: new TextDecoder().decode(frame.subarray(58)).replace(/\0.*$/, ''),
    };
  }

  setName(name) {
    const bytes = new TextEncoder().encode(name);
    return this.command([CMD.SET_ADVERT_NAME, ...bytes], 'Set node name');
  }

  /**
   * Wire format is freq in kHz and bandwidth in Hz, both u32 little-endian;
   * firmware divides each by 1000 into its MHz/kHz floats on arrival.
   */
  setRadio({ freqMHz, bwKHz, sf, cr }) {
    const buf = new Uint8Array(11);
    const view = new DataView(buf.buffer);
    buf[0] = CMD.SET_RADIO_PARAMS;
    view.setUint32(1, Math.round(freqMHz * 1000), true);
    view.setUint32(5, Math.round(bwKHz * 1000), true);
    buf[9] = sf;
    buf[10] = cr;
    return this.command([...buf], 'Set radio parameters');
  }

  setTxPower(dbm) {
    return this.command([CMD.SET_RADIO_TX_POWER, dbm & 0xff], 'Set transmit power');
  }

  /** mode 0 = 1-byte path hashes, 1 = 2-byte. Byte 1 is a reserved zero. */
  setPathHashMode(mode) {
    return this.command([CMD.SET_PATH_HASH_MODE, 0, mode], 'Set 2-byte path hashes');
  }

  async setTime(epochSeconds) {
    const buf = new Uint8Array(5);
    new DataView(buf.buffer).setUint32(1, epochSeconds, true);
    buf[0] = CMD.SET_DEVICE_TIME;
    try {
      await this.command([...buf], 'Sync clock');
    } catch (err) {
      // Firmware refuses to move the clock backwards; a GPS-synced radio can
      // legitimately be ahead of this computer.
      if (err.errorCode === 6) throw new Error("Sync clock: the radio's clock is already ahead of this computer");
      throw err;
    }
  }

  /** type 1 = flood-routed, so the whole mesh learns about this node. */
  sendFloodAdvert() {
    return this.command([CMD.SEND_SELF_ADVERT, 1], 'Send advert');
  }

  /**
   * Sets a sensor/device variable, sent as "name:value". GPS lives here on
   * companion firmware. Boards built without GPS answer ERR (illegal arg).
   */
  setCustomVar(name, value) {
    const bytes = new TextEncoder().encode(`${name}:${value}`);
    return this.command([CMD.SET_CUSTOM_VAR, ...bytes], `Set ${name}`);
  }

  async setGps(enabled) {
    try {
      await this.setCustomVar('gps', enabled ? '1' : '0');
    } catch (err) {
      if (err.errorCode === 6) throw new Error('Set GPS: this board has no GPS receiver');
      throw err;
    }
  }

  /**
   * Turning the GPS receiver on does not by itself put a position in adverts;
   * that is advert_loc_policy, set via SET_OTHER_PARAMS. The other bytes in
   * that command must be echoed back from SELF_INFO or they get reset.
   */
  setAdvertLocationPolicy(policy, selfInfo) {
    return this.command([
      CMD.SET_OTHER_PARAMS,
      selfInfo.manualAddContacts ?? 0,
      selfInfo.telemetryModes ?? 0,
      policy,
      selfInfo.multiAcks ?? 0,
    ], 'Share position in adverts');
  }

  /** The radio reboots without replying, so this is fire-and-forget. */
  async reboot() {
    const bytes = new TextEncoder().encode('reboot');
    await this.transport.sendPayload(Uint8Array.from([CMD.REBOOT, ...bytes]));
  }
}
