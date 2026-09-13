/**
 * Loads and validates config.json, the one file to edit when retuning this
 * configurator for a network.
 *
 * The limits below are the ones the MeshCore firmware itself enforces. A value
 * outside them is rejected by the radio at configure time, which is a
 * miserable way to find out, so the same checks run here: on page load, and in
 * `npm test` so a bad edit fails before it ships.
 *
 * Sources:
 *   examples/companion_radio/MyMesh.cpp   CMD_SET_RADIO_PARAMS bounds
 *   src/helpers/CommonCLI.cpp             advert interval bounds
 */

export const FIRMWARE_LIMITS = {
  // Sent as kHz and Hz on the wire; firmware range-checks both.
  frequencyMHz: { min: 150, max: 2500 },
  bandwidthKHz: { min: 7, max: 500 },
  spreadingFactor: { min: 5, max: 12 },
  codingRate: { min: 5, max: 8 },
  // SX1262-class parts top out at 22 dBm; firmware clamps per board anyway.
  txPowerDbm: { min: -9, max: 22 },
  // 0 = 1-byte path hashes, 1 = 2-byte. Mode 2 exists; 3+ is reserved.
  pathHashMode: { min: 0, max: 2 },
  // "Error: interval range is 3-168 hours". Firmware also accepts 0 (off);
  // this app deliberately does not, since a repeater that never adverts is
  // invisible to the mesh.
  floodAdvertHours: { min: 3, max: 168 },
  // MIN_LOCAL_ADVERT_INTERVAL is 60; "interval range is 60-240 minutes". As
  // above, 0 (off) is valid firmware but not offered here.
  zeroHopAdvertMinutes: { min: 60, max: 240 },
};

class ConfigError extends Error {}

function inRange(value, path, limit, { integer = false } = {}) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ConfigError(`config.json: ${path} must be a number, got ${JSON.stringify(value)}`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new ConfigError(`config.json: ${path} must be a whole number, got ${value}`);
  }
  if (value < limit.min || value > limit.max) {
    throw new ConfigError(
      `config.json: ${path} is ${value}, outside the ${limit.min}–${limit.max} the firmware accepts`,
    );
  }
  return value;
}

function required(object, key, path) {
  if (object == null || !(key in object)) {
    throw new ConfigError(`config.json: missing ${path}`);
  }
  return object[key];
}

const trimNumber = (n) => String(Number(n.toFixed(3))).replace(/\.0+$/, '');

function nonEmptyString(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigError(`config.json: ${path} must be a non-empty string`);
  }
  return value.trim();
}

function optionalUrl(value, path) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || !/^https?:\/\//.test(value)) {
    throw new ConfigError(`config.json: ${path} must be an http(s) URL, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The companion path rounds to whole kHz / Hz on the wire while the CLI path
 * sends the decimal verbatim, so a value with finer precision than that
 * would configure the two firmware types differently.
 */
function wholeOnWire(value, path, multiplier, unit) {
  if (!Number.isInteger(Math.round(value * multiplier * 1e6) / 1e6)) {
    throw new ConfigError(`config.json: ${path} must be a whole number of ${unit} (got ${value})`);
  }
  return value;
}

/* Region names travel as a fixed 2-byte hash, so length costs nothing on the
   air, but the string itself is a namespace shared with neighbouring meshes:
   one lowercase spelling per scope, or two networks mean different things by
   the same name. */
const REGION_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The optional `regions` list, in the order `region put` must run.
 *
 * A parent has to exist on the repeater before a child can name it, so the
 * list is required to define parents first. That ordering rule is also what
 * makes a cycle impossible: a region can only point backwards.
 */
function validateRegions(raw) {
  const regions = raw.regions ?? [];
  if (!Array.isArray(regions)) throw new ConfigError('config.json: regions must be an array');

  const seen = new Set();
  return regions.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new ConfigError(`config.json: regions[${i}] must be an object with a name`);
    }
    const { name } = entry;
    if (typeof name !== 'string' || !REGION_NAME.test(name)) {
      throw new ConfigError(`config.json: regions[${i}].name must be lowercase letters, digits and single hyphens, got ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) {
      throw new ConfigError(`config.json: regions[${i}].name repeats ${JSON.stringify(name)}, already defined above`);
    }
    const parent = entry.parent ?? '';
    if (parent !== '') {
      if (typeof parent !== 'string') {
        throw new ConfigError(`config.json: regions[${i}].parent must be a string`);
      }
      if (!seen.has(parent)) {
        throw new ConfigError(`config.json: regions[${i}].parent must name a region defined earlier in the list, got ${JSON.stringify(parent)}`);
      }
    }
    seen.add(name);
    return { name, parent };
  });
}

/**
 * Turns raw config.json into the profile the app uses, or throws a message
 * that names the offending field. Pure, so tests can run it without a browser.
 */
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new ConfigError('config.json is not an object');

  const preset = required(raw, 'preset', 'preset');
  const radio = {
    freqMHz: wholeOnWire(inRange(required(preset, 'frequencyMHz', 'preset.frequencyMHz'), 'preset.frequencyMHz', FIRMWARE_LIMITS.frequencyMHz), 'preset.frequencyMHz', 1000, 'kHz'),
    bwKHz: wholeOnWire(inRange(required(preset, 'bandwidthKHz', 'preset.bandwidthKHz'), 'preset.bandwidthKHz', FIRMWARE_LIMITS.bandwidthKHz), 'preset.bandwidthKHz', 1000, 'Hz'),
    sf: inRange(required(preset, 'spreadingFactor', 'preset.spreadingFactor'), 'preset.spreadingFactor', FIRMWARE_LIMITS.spreadingFactor, { integer: true }),
    cr: inRange(required(preset, 'codingRate', 'preset.codingRate'), 'preset.codingRate', FIRMWARE_LIMITS.codingRate, { integer: true }),
  };

  const repeater = required(raw, 'repeater', 'repeater');
  const network = required(raw, 'network', 'network');

  const label = nonEmptyString(required(preset, 'label', 'preset.label'), 'preset.label');

  const minFirmware = raw.minFirmwareForPathHash ?? '1.14.0';
  if (!/^v?\d+(\.\d+)*$/.test(String(minFirmware))) {
    throw new ConfigError(`config.json: minFirmwareForPathHash must look like "1.14.0", got ${JSON.stringify(minFirmware)}`);
  }

  const otherRegions = raw.otherRegions ?? [];
  if (!Array.isArray(otherRegions)) throw new ConfigError('config.json: otherRegions must be an array');
  otherRegions.forEach((r, i) => {
    nonEmptyString(r?.label, `otherRegions[${i}].label`);
    nonEmptyString(r?.summary, `otherRegions[${i}].summary`);
  });

  return {
    network: {
      name: nonEmptyString(required(network, 'name', 'network.name'), 'network.name'),
      site: optionalUrl(network.site, 'network.site'),
      guide: optionalUrl(network.guide, 'network.guide'),
    },
    label,
    radio,
    // Derived, never hand-written, so the displayed summary cannot drift
    // from the values actually sent to the radio.
    summary: `${trimNumber(radio.freqMHz)} MHz · SF${radio.sf} · BW${trimNumber(radio.bwKHz)} · CR${radio.cr}`,
    txPowerDbm: inRange(required(raw, 'txPowerDbm', 'txPowerDbm'), 'txPowerDbm', FIRMWARE_LIMITS.txPowerDbm, { integer: true }),
    pathHashMode: inRange(required(raw, 'pathHashMode', 'pathHashMode'), 'pathHashMode', FIRMWARE_LIMITS.pathHashMode, { integer: true }),
    minFirmwareForPathHash: String(minFirmware),
    floodAdvertHours: inRange(required(repeater, 'floodAdvertHours', 'repeater.floodAdvertHours'), 'repeater.floodAdvertHours', FIRMWARE_LIMITS.floodAdvertHours, { integer: true }),
    zeroHopAdvertMinutes: inRange(required(repeater, 'zeroHopAdvertMinutes', 'repeater.zeroHopAdvertMinutes'), 'repeater.zeroHopAdvertMinutes', FIRMWARE_LIMITS.zeroHopAdvertMinutes, { integer: true }),
    otherRegions,
    regions: validateRegions(raw),
  };
}

/** Fetches and validates config.json. */
export async function loadProfile(url = '/config.json') {
  let response;
  try {
    response = await fetch(url, { cache: 'no-cache' });
  } catch (cause) {
    throw new ConfigError(`Could not load ${url}: ${cause.message}`);
  }
  if (!response.ok) throw new ConfigError(`Could not load ${url}: HTTP ${response.status}`);

  let raw;
  try {
    raw = await response.json();
  } catch {
    // A missing file is served as index.html by the SPA fallback, so a JSON
    // parse failure here usually means the file isn't deployed.
    throw new ConfigError(`${url} is not valid JSON. Is it deployed?`);
  }
  return validateConfig(raw);
}
