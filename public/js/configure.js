/**
 * Builds and runs the ordered list of steps that takes a freshly flashed
 * radio to the Liberty Hill Mesh configuration.
 *
 * Each step reports progress so the UI can show exactly what was written
 * rather than a single opaque spinner. Steps marked `optional` record a
 * note and carry on; anything else aborts the run.
 */

/** Sentinel a step returns to mark itself skipped rather than done. */
export const SKIP = Symbol('skip');

export const STATUS = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  skipped: 'skipped',
  failed: 'failed',
};

// CommonCLI::isValidName rejects these; the companion accepts them, but a name
// should survive reflashing a board to the other firmware.
const FORBIDDEN_NAME_CHARS = /[[\]\\:,?*]/;
// node_name[32] in firmware: 31 bytes plus terminator, truncated silently.
export const MAX_NAME_BYTES = 31;

/**
 * Returns an error message for a node name the radio would reject or mangle,
 * or null if it is fine. Counts UTF-8 bytes, not characters, because that is
 * what the firmware truncates on.
 */
export function validateNodeName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return 'Give your node a name first.';
  const bad = trimmed.match(FORBIDDEN_NAME_CHARS);
  if (bad) return `Names can't contain ${bad[0] === ' ' ? 'spaces' : `"${bad[0]}"`}. The radio rejects [ ] \\ : , ? and *.`;
  const bytes = new TextEncoder().encode(trimmed).length;
  if (bytes > MAX_NAME_BYTES) {
    return bytes === trimmed.length
      ? `That's ${bytes} characters; the radio stores at most ${MAX_NAME_BYTES}.`
      : `That's ${bytes} bytes once encoded (accented or symbol characters count for more); the radio stores at most ${MAX_NAME_BYTES}.`;
  }
  return null;
}

/** Compares dotted version strings, tolerating a leading "v" and suffixes. */
export function versionAtLeast(version, minimum) {
  const parse = (v) => (String(v).match(/\d+/g) ?? []).map(Number);
  const a = parse(version);
  const b = parse(minimum);
  if (!a.length) return false;
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    if (x > b[i]) return true;
    if (x < b[i]) return false;
  }
  return true;
}

export async function runPlan(steps, onStep) {
  const results = steps.map((s) => ({ label: s.label, status: STATUS.pending, detail: '' }));
  const publish = () => onStep(results.map((r) => ({ ...r })));
  publish();

  for (let i = 0; i < steps.length; i++) {
    results[i].status = STATUS.running;
    publish();
    try {
      const detail = await steps[i].run();
      if (detail === SKIP) {
        results[i].status = STATUS.skipped;
      } else {
        results[i].status = STATUS.done;
        if (typeof detail === 'string') results[i].detail = detail;
      }
    } catch (err) {
      results[i].status = steps[i].optional ? STATUS.skipped : STATUS.failed;
      results[i].detail = err.message;
      publish();
      if (!steps[i].optional) {
        const error = new Error(`${steps[i].label} failed: ${err.message}`);
        error.results = results;
        throw error;
      }
    }
    publish();
  }
  return results;
}

/** Shared by both firmware types: name, radio, power, 2-byte paths. */
function commonSteps(client, { name, device, maxTxPower, profile }) {
  const { radio, txPowerDbm, pathHashMode, minFirmwareForPathHash } = profile;
  const power = Math.min(txPowerDbm, maxTxPower || txPowerDbm);
  const supportsPathHash =
    !device.firmwareVersion || versionAtLeast(device.firmwareVersion, minFirmwareForPathHash);

  return [
    {
      label: 'Set node name',
      run: async () => { await client.setName(name); return name; },
    },
    {
      label: `Apply ${profile.label} radio settings`,
      run: async () => { await client.setRadio(radio); return profile.summary; },
    },
    {
      label: 'Set transmit power',
      run: async () => {
        await client.setTxPower(power);
        return power < txPowerDbm ? `${power} dBm, the board's maximum` : `${power} dBm`;
      },
    },
    {
      label: `Use ${pathHashBytes(pathHashMode)}-byte path hashes`,
      optional: true,
      run: async () => {
        if (!supportsPathHash) {
          throw new Error(`needs firmware ${minFirmwareForPathHash} or newer, this radio has ${device.firmwareVersion}`);
        }
        await client.setPathHashMode(pathHashMode);
        return `path.hash.mode ${pathHashMode}`;
      },
    },
  ];
}

/** path.hash.mode 0 → 1 byte, 1 → 2 bytes. */
export const pathHashBytes = (mode) => mode + 1;

/**
 * Two firmware settings, so two visible steps: the GPS receiver itself, and
 * advert_loc_policy, which decides whether adverts carry a position at all.
 * Turning the receiver on without the policy puts nothing on the map.
 * With GPS off the policy is left alone, so a repeater with a hand-set
 * position keeps it.
 */
function gpsSteps(client, gps, { selfInfo } = {}) {
  let receiverOn = false;
  const receiver = {
    label: gps ? 'Turn on GPS receiver' : 'Turn off GPS receiver',
    optional: true,
    run: async () => {
      await client.setGps(gps);
      receiverOn = gps;
      return gps ? 'on' : 'off';
    },
  };
  if (!gps) return [receiver];

  return [
    receiver,
    {
      label: 'Share position in adverts',
      optional: true,
      run: async () => {
        // Without a working receiver the "live fix" is 0,0, the Gulf of
        // Guinea, so never enable sharing unless the receiver came on.
        if (!receiverOn) throw new Error('skipped: the GPS receiver could not be turned on');
        await (selfInfo
          ? client.setAdvertLocationPolicy(1 /* ADVERT_LOC.SHARE */, selfInfo)
          : client.setAdvertLocationPolicy('share'));
        return 'live GPS fix goes out with each advert';
      },
    },
  ];
}

const clockStep = (client) => ({
  label: 'Sync clock',
  optional: true,
  run: async () => {
    await client.setTime(Math.floor(Date.now() / 1000));
    return new Date().toUTCString();
  },
});

/** Companion firmware. It has no advert-interval settings; it adverts on demand. */
export function planCompanion(client, { name, gps, device, selfInfo, profile }) {
  return [
    ...commonSteps(client, { name, device, maxTxPower: selfInfo.maxTxPower, profile }),
    ...gpsSteps(client, gps, { selfInfo }),
    clockStep(client),
    {
      label: 'Announce to the mesh',
      optional: true,
      run: async () => { await client.sendFloodAdvert(); return 'flood advert sent'; },
    },
  ];
}

/** Repeaters and room servers re-announce on a timer, and need a reboot. */
export function planRepeater(client, { name, gps, device, profile }) {
  return [
    ...commonSteps(client, { name, device, profile }),
    {
      label: 'Set advert intervals',
      run: async () => {
        await client.setFloodAdvertInterval(profile.floodAdvertHours);
        await client.setZeroHopAdvertInterval(profile.zeroHopAdvertMinutes);
        return `whole mesh every ${profile.floodAdvertHours} h, neighbours every ${profile.zeroHopAdvertMinutes} min`;
      },
    },
    ...gpsSteps(client, gps),
    clockStep(client),
    {
      label: 'Reboot to apply',
      optional: true,
      // Repeaters only pick up new radio parameters on restart, and an
      // "advert" issued now would be queued 1.5 s out; the reboot would
      // discard it, and it would go out on the old frequency anyway. The
      // radio sends a zero-hop advert itself ~16 s after boot.
      run: async () => { await client.reboot(); return 'restarting now; it will announce itself shortly after'; },
    },
  ];
}
