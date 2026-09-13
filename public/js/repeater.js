/**
 * MeshCore repeater / room-server client (text CLI over USB serial).
 *
 * Repeater firmware has no companion binary protocol; it exposes the
 * CommonCLI command set instead. Every command answers with a single
 * "  -> <reply>" line, which MeshPort.takeCliReply() extracts.
 */

// Every reply this app depends on begins "OK"/"ok", sometimes parenthesised
// ("(OK - stats reset)"). Errors are varied: "Error, bad chars",
// "ERR: ...", "(ERR: clock cannot go backwards)", "Unknown command",
// "gps toggle not found", so success is the thing to match, not failure.
const SUCCESS = /^\(?\s*ok\b/i;

/**
 * The exact CLI line for one region. Exported because the configure step
 * quotes these commands before sending them, and a preview that drifts from
 * what is actually written is worse than no preview at all.
 */
export function regionPutLine({ name, parent = '' }) {
  return parent ? `region put ${name} ${parent}` : `region put ${name}`;
}

export class RepeaterClient {
  constructor(port) {
    this.port = port;
  }

  /** Sends one CLI command and resolves with its reply line. */
  async send(command, { timeout = 5000 } = {}) {
    this.port.clearAll();
    await this.port.sendLine(command);

    const deadline = Date.now() + timeout;
    for (;;) {
      const reply = this.port.takeCliReply();
      if (reply !== null) return reply;
      if (Date.now() > deadline) {
        throw new Error(`the radio did not answer "${command}"`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Like send(), but anything other than an OK reply is a thrown failure. */
  async command(cmd, label) {
    const reply = await this.send(cmd);
    if (!SUCCESS.test(reply)) throw new Error(`${label}: ${reply}`);
    return reply;
  }

  /**
   * The firmware's line buffer keeps every byte it has seen until a '\r'
   * arrives, so bytes from a failed companion probe would prefix the first
   * real command. An empty line flushes them; the "Unknown command" reply
   * (or silence, if the buffer was already clean) is discarded.
   */
  async flushLine() {
    try {
      await this.send('', { timeout: 700 });
    } catch {
      // Nothing buffered; no reply is the good case.
    }
  }

  /** Probe used to detect CLI firmware. Replies look like "> repeater". */
  async getRole({ timeout = 1500 } = {}) {
    const reply = await this.send('get role', { timeout });
    const match = reply.match(/^>\s*(\S.*)$/);
    if (!match) throw new Error(`unexpected reply to "get role": ${reply}`);
    return match[1].trim();
  }

  async getVersion() {
    try {
      return await this.send('ver', { timeout: 2000 });
    } catch {
      return '';
    }
  }

  setName(name) {
    return this.command(`set name ${name}`, 'Set node name');
  }

  /** CommonCLI takes all four radio parameters as one comma-separated value. */
  setRadio({ freqMHz, bwKHz, sf, cr }) {
    return this.command(`set radio ${freqMHz},${bwKHz},${sf},${cr}`, 'Set radio parameters');
  }

  setTxPower(dbm) {
    return this.command(`set tx ${dbm}`, 'Set transmit power');
  }

  setPathHashMode(mode) {
    return this.command(`set path.hash.mode ${mode}`, 'Set path hash mode');
  }

  /**
   * Regions this repeater already re-transmits for.
   *
   * The exact shape of `region list allowed` output is not something to rely
   * on, so this parse is deliberately loose and its result is only ever shown
   * to a person: nothing branches on it. A surprise in the format costs a
   * slightly odd message, never a wrong write.
   */
  async listRegions() {
    const reply = await this.send('region list allowed');
    if (/not found|unknown command/i.test(reply)) throw new Error('Unknown command');
    return reply
      .split(/[\r\n]+/)
      .map((line) => line.replace(/^\s*->\s*/, '').trim())
      .filter((line) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(line));
  }

  /** Adds one region, optionally naming the parent it nests under. */
  putRegion(name, parent = '') {
    return this.command(regionPutLine({ name, parent }), `Add region ${name}`);
  }

  /** Regions live in RAM until this writes them to flash. */
  saveRegions() {
    return this.command('region save', 'Save regions');
  }

  /** Whole-mesh re-announcement, in hours. Firmware accepts 0 (off) or 3-168. */
  setFloodAdvertInterval(hours) {
    return this.command(`set flood.advert.interval ${hours}`, 'Set flood advert interval');
  }

  /** Neighbours-only re-announcement, in minutes. Firmware accepts 0 (off) or 60-240. */
  setZeroHopAdvertInterval(minutes) {
    return this.command(`set advert.interval ${minutes}`, 'Set zero-hop advert interval');
  }

  /** Boards without GPS support reply "gps toggle not found" or "Unknown command". */
  async setGps(enabled) {
    try {
      return await this.command(enabled ? 'gps on' : 'gps off', 'Set GPS');
    } catch (err) {
      if (/not found|unknown command/i.test(err.message)) throw new Error('Set GPS: this board has no GPS receiver');
      throw err;
    }
  }

  /**
   * Whether adverts carry a position: "share" uses the live GPS fix, "prefs"
   * the manually set lat/lon, "none" nothing. Turning GPS on does not change
   * this by itself.
   */
  setAdvertLocationPolicy(policy) {
    return this.command(`gps advert ${policy}`, 'Share position in adverts');
  }

  setTime(epochSeconds) {
    return this.command(`time ${epochSeconds}`, 'Sync clock');
  }

  /** The radio reboots without replying, so this is fire-and-forget. */
  async reboot() {
    await this.port.sendLine('reboot');
  }
}
