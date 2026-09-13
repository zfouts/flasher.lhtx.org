/**
 * Turns flasher.meshcore.io's config.json into this site's board catalogue.
 *
 * Shared by the Worker (which fetches the live file on every request, edge
 * cached for a few minutes), by scripts/sync-boards.mjs (which writes the
 * offline fallback public/boards.json), and by the tests. Only community
 * firmware published as a GitHub release of meshcore-dev/MeshCore is kept;
 * the proprietary Ripple / MeshOS images and the KISS modem builds are not
 * what this configurator sets up.
 */

export const FLASHER_REPO = 'meshcore-dev/flasher.meshcore.io';
/** The file flasher.meshcore.io itself loads; what it offers, we offer. */
export const FLASHER_CONFIG_URL = 'https://flasher.meshcore.io/config.json';

/** Which flasher role names this configurator knows how to set up. */
export const ROLES = {
  companionUsb: { title: 'Companion (USB)', release: 'companion', kind: 'companion', transport: 'usb' },
  companionBle: { title: 'Companion (Bluetooth)', release: 'companion', kind: 'companion', transport: 'ble' },
  repeater: { title: 'Repeater', release: 'repeater', kind: 'repeater', transport: 'usb' },
  roomServer: { title: 'Room server', release: 'room-server', kind: 'repeater', transport: 'usb' },
};

/**
 * Pure: turns the flasher's config.json into this site's board catalogue.
 * Exported so the test can pin the shape without network access.
 */
export function reduceFlasherConfig(config, source) {
  const makers = config.maker ?? {};
  const boards = [];

  for (const device of config.device ?? []) {
    if (!['esp32', 'nrf52'].includes(device.type)) continue;

    const roles = {};
    for (const fw of device.firmware ?? []) {
      const role = ROLES[fw.role];
      // "github" = community firmware published on meshcore-dev/MeshCore.
      // Anything without it (bundled files, Ripple's own repo) is skipped.
      if (!role || fw.class !== 'community' || !fw.github?.files) continue;
      if (fw.github.type !== role.release) continue;
      // Variants like "[no display]" are separate entries; keep the plain one.
      if (roles[fw.role]) continue;

      const files = {};
      for (const [kind, pattern] of Object.entries(fw.github.files)) {
        new RegExp(pattern); // throws on a bad pattern, which we want at sync time
        files[kind] = pattern;
      }
      // The page flashes ESP32s from -merged.bin / .bin and nRF52s from the
      // DFU .zip. An entry whose files do not fit its platform (the upstream
      // list has a few) is skipped rather than offered and failing later.
      const fits = device.type === 'esp32'
        ? files['flash-wipe'] && files['flash-update']
        : files.flash;
      if (!fits) continue;
      roles[fw.role] = { files };
    }
    if (!Object.keys(roles).length) continue;

    boards.push({
      id: device.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, ''),
      maker: makers[device.maker]?.name ?? device.maker ?? '',
      name: device.name,
      type: device.type,
      roles,
    });
  }

  boards.sort((a, b) => a.name.localeCompare(b.name));
  return { source, roles: ROLES, boards };
}
