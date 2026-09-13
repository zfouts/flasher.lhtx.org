# flasher.lhtx.org

A MeshCore radio setup wizard for [Liberty Hill Mesh](https://lhtx.org/): flash the
firmware, then configure it. Pick your board and its role, see exactly which file will be
written and where it comes from, verify its hash, flash it, give the node a name, decide
about GPS, and press the button. Everything else is fixed by the Liberty Hill Mesh
profile. A radio already running MeshCore can skip straight to the configure half.

It asks exactly two things, **node name** and **enable GPS**, because every other setting
is one the whole network has to agree on.

## What it writes

<!-- BEGIN GENERATED SETTINGS -->
<!-- Generated from public/config.json by `npm run docs`. Do not edit by hand. -->

| Setting | Value |
| --- | --- |
| Region preset | USA / Canada (Recommended): 910.525 MHz · SF7 · BW62.5 · CR5 |
| Transmit power | 22 dBm (clamped to the board's maximum) |
| Path hashes | 2-byte (`path.hash.mode 1`) |
| Node name | yours |
| GPS | your choice; on also sets `advert_loc_policy` to share the live fix, so the node appears on the map; off leaves position sharing untouched |
| Clock | synced from the browser |
| Flood advert interval | every 12 hours *(repeaters only)* |
| Zero-hop advert interval | every 60 minutes *(repeaters only)* |

<!-- END GENERATED SETTINGS -->

The preset is MeshCore's own **USA / Canada (Recommended)**, the one every radio from
Killeen to San Antonio already runs, taken from the community preset list at
`api.meshcore.nz/api/v1/config`. It is the same set of numbers documented on
[lhtx.org/join](https://lhtx.org/join/).

## Changing the settings

Everything above lives in **[`public/config.json`](public/config.json)**, one plain JSON
file, no build step, no JavaScript to read. Edit it, run `npm run docs`, done:

```jsonc
{
  "network": { "name": "Liberty Hill Mesh", "site": "…", "guide": "…" },
  "preset": {
    "label": "USA / Canada (Recommended)",
    "frequencyMHz": 910.525,
    "bandwidthKHz": 62.5,
    "spreadingFactor": 7,
    "codingRate": 5
  },
  "txPowerDbm": 22,
  "pathHashMode": 1,
  "repeater": { "floodAdvertHours": 12, "zeroHopAdvertMinutes": 60 }
}
```

Three things keep that honest:

- **Values are range-checked against the firmware's own limits** whenever the page loads
  and on every `npm test`. Set `floodAdvertHours` to 2 and you get
  `repeater.floodAdvertHours is 2, outside the 3–168 the firmware accepts`, rather than a
  radio that silently refuses the setting. The limits are in `FIRMWARE_LIMITS` in
  [`public/js/profile.js`](public/js/profile.js), each cited to the firmware source.
- **The settings table above is generated** from `config.json` by `npm run docs`, and
  `npm test` fails if it is stale. The docs cannot drift from the values.
- **The on-screen summary is derived**, never hand-written, so what the page claims and
  what it sends to the radio are the same numbers.

The network name and links in the page are filled from `config.json` too, so adapting this
for your own mesh means editing that file and swapping the brand assets, no code changes.

Companion firmware has no advert-interval settings in firmware at all (it advertises when
asked), so those two rows apply only to repeaters and room servers.

## Region scope (optional, repeaters only)

A region is not a radio setting and not a channel. Channels decide who can
decrypt a message; regions decide how far a repeater forwards it. Mixing the
two up is the usual cause of flood traffic on a growing mesh: a message on a
local channel still reaches every distant repeater in range unless its region
scopes it.

Regions nest, and traffic moves one way through the nesting. A message sent on
a parent cascades down to its children, while local traffic sent on a child is
ignored by parent-only backbones. Names compile to a fixed 2-byte hash over the
air, so a long name costs nothing and there is no reason not to scope tightly.

The hierarchy lives in `public/config.json`, in the order `region put` needs,
parents before children:

```jsonc
"regions": [
  { "name": "us" },
  { "name": "us-south", "parent": "us" },
  { "name": "us-southcentral", "parent": "us-south" },
  { "name": "us-tx", "parent": "us-southcentral" },
  { "name": "us-tx-central", "parent": "us-tx" },
  { "name": "us-tx-aus", "parent": "us-tx-central" },
  { "name": "lhtx" }
]
```

Country, census region, census division, state, division, metro — then `lhtx`
standalone, for local traffic that should not climb the chain. Carrying a
region is not the same as nesting under it: a repeater running all seven gets
cascades from every level above while keeping `lhtx` to itself.

Three things to know about how it is applied:

- **It is opt-in and off by default.** A checkbox on the configure step, shown
  only for repeaters and room servers, and only when `regions` is present in
  `config.json`. Remove the key and the feature disappears entirely.
- **It only ever adds.** Regions already on the radio are listed in the result
  and left alone. A repeater bridging two corridors carries several regions
  deliberately, and a setup wizard is the wrong thing to tear that down.
  Removing a region is `region remove`, children first, by hand.
- **Old firmware skips it.** Without the `region` command the step is reported
  as skipped and the rest of the run finishes.

Companions set their region scope in the MeshCore app, under Tools → Discover
Regions, not over the wire — this tool does not touch them.

The names are a namespace shared with neighbouring meshes, so they are only
worth anything if your neighbours use the same spellings. Agree them first.

## How flashing works, and what you are shown

The flash half is built on the same sources as [flasher.meshcore.io](https://flasher.meshcore.io/)
and shows all of them before anything is written:

| What | Where it comes from | Shown on screen |
| --- | --- | --- |
| Board list and which release file each role uses | flasher.meshcore.io's own `config.json`, refetched hourly by the Worker and served from `/api/boards`. If that route fails, [`public/boards.json`](public/boards.json), a pinned copy kept current by `npm run boards`, is used and the page says so | the source URL, when it was fetched, its last-modified date; or the fallback commit and date |
| Firmware versions and files | GitHub releases of [meshcore-dev/MeshCore](https://github.com/meshcore-dev/MeshCore/releases), refetched hourly by the Worker and served from `/api/releases` | version, date, release page, release notes, when the list was fetched |
| The image itself | the release asset on github.com, relayed by `/api/firmware/<tag>/<file>` because github.com sends no CORS headers on downloads | file name, size, the exact github.com URL, the relay path, and the CDN host that answered |
| Integrity | the SHA-256 GitHub publishes for the asset (the releases API `digest` field), compared in the browser with the SHA-256 of the bytes received | both hashes, and a match / mismatch / unverifiable verdict |
| Settings applied afterwards | `public/config.json` | the full list, on the review screen and again before configuring |

A mismatch, or a file GitHub publishes no hash for, disables the Flash button. The relay
never rewrites bytes; the hash check is how you know. A verified download stops counting
the moment you change board, role, version or install mode, so the flash step can never
open on bytes fetched for a different choice.

Flashing itself follows flasher.meshcore.io's sequence: ESP32 boards through
[esptool-js](https://github.com/espressif/esptool-js) at 115200 baud (a fresh install
writes the `-merged.bin` at 0x0 and erases the flash first; an update writes the app `.bin`
at 0x10000 and keeps the radio's identity), nRF52 boards through the Nordic serial DFU
protocol from flasher.meshcore.io's `lib/dfu.js` with the DFU `.zip`, after a double-tap
of reset or the 1200-baud touch. The `.zip` is unpacked by a 100-line reader on top of the
browser's `DecompressionStream` rather than a bundled zip library.

Prefer the official flasher? The first step links to it with your board and role selected,
and lists the settings to enter by hand, including the repeater CLI lines.

### The Worker

`src/worker.js` handles only `/api/*`; everything else is a static asset. A Cron Trigger
runs its `scheduled()` once an hour, which fetches flasher.meshcore.io's `config.json` and
the MeshCore releases list, reduces both, and stores them in KV. `/api/boards` and
`/api/releases` answer from that store, so a visitor never waits on GitHub and GitHub sees
one request an hour rather than one per visitor; its anonymous limit is 60 an hour per
address, and a Worker's outbound address is shared, so that matters. A failed refresh
keeps the previous copy. A copy older than three hours is served as-is and refreshed in
the background; an empty store (first deploy) fetches on demand. No token or account is
involved anywhere.

`/api/firmware/<tag>/<file>` refuses any tag that is not `companion-`, `repeater-` or
`room-server-v*` and any file name that is not a `.bin`, `.zip` or `.uf2`, so it cannot be
used as a general proxy. Assets are edge-cached for a week.

## How it talks to radios

Everything happens in the browser. Nothing about a radio is sent anywhere.

A MeshCore device speaks one of two protocols depending on the firmware flashed onto it,
and nothing announces which, so the app probes for one and falls back to the other:

| Firmware | Transport | Protocol |
| --- | --- | --- |
| Companion | USB serial or Bluetooth | binary frames (`0x3c` out / `0x3e` in over serial; raw payloads over BLE) |
| Repeater / room server | USB serial only | text CLI, replies prefixed `  -> ` |

Command codes and byte layouts were taken from the firmware source
(`MeshCore/examples/companion_radio/MyMesh.cpp` and `src/helpers/CommonCLI.cpp`), not from
`meshcore.js`; that library lags the firmware and is missing `SET_PATH_HASH_MODE`, which
is how 2-byte paths get enabled.

Companion firmware comes in three builds, and only one of them listens on USB:
`companion_radio_usb` (`ENABLE_USB_INTERFACE`). The `_ble` build, the one most people
flash for phone use, has no USB interface compiled in at all, so it is silent on the
serial port. The page says this up front, and a failed detection distinguishes *nothing
arrived* (bootloader / DFU mode, or a BLE-only companion) from *something unrecognised
arrived* (wrong firmware, or a board still booting), quoting what it saw and the USB id
so a report can be acted on.

DFU / bootloader mode is never needed here; it is only for the flasher. Boards with a
USB-UART bridge reset when the port opens, so detection waits for the boot log to go
quiet before probing.

Requires Chrome, Edge, or Opera: Web Serial and Web Bluetooth are unavailable in Safari
and Firefox. The app detects this and says so rather than failing silently.

### Source layout

```
public/config.json      the settings, the only file most edits need
public/js/profile.js    loads config.json and range-checks it against the firmware
public/js/boot.js       classic script, no imports: hides the browser warning once a browser proves itself
public/js/capability.js what this browser can reach a radio with, and what to say when the answer is nothing
public/js/port.js       USB serial: one read loop feeding a frame parser and a text buffer
public/js/diagnose.js   explains a failed detection from what actually arrived
public/js/ble.js        Web Bluetooth transport (companion firmware only)
public/js/companion.js  binary companion protocol client
public/js/repeater.js   text CLI client
public/js/configure.js  builds and runs the ordered, reportable step plan
public/js/firmware.js   board catalogue, release lookup, download and SHA-256 verification
public/js/zip.js        minimal ZIP reader for nRF52 DFU packages
public/js/flash.js      writes verified bytes: esptool-js for ESP32, serial DFU for nRF52
public/js/steps.js      which step the current state allows, and the URL slug for each
public/js/app.js        wizard UI
public/boards.json      offline fallback for the board list, generated by `npm run boards`
src/boards.js           reduces flasher.meshcore.io's config.json to the board catalogue
src/worker.js           Cloudflare Worker: /api/releases and /api/firmware/<tag>/<file>
src/releases.js         the Worker's pure parts: tag/asset validation, releases reduction
public/vendor/          esptool-js (Apache-2.0) and flasher.meshcore.io's dfu.js (MIT), see NOTICE
scripts/sync-boards.mjs regenerates public/boards.json (`npm run boards`)
scripts/sync-readme.mjs regenerates the settings table above from config.json (`npm run docs`)
```

## Develop

```sh
npm install
npm run dev      # wrangler dev, http://localhost:8787
npm test         # config, protocol, plan, Worker, zip, steps and firmware tests; no hardware or network
npm run docs     # regenerate the settings table in README.md from config.json
npm run boards   # refresh the fallback public/boards.json at the pinned flasher.meshcore.io commit
npm run boards:latest   # move the pin to flasher.meshcore.io's current main
```

`npm test` covers the wire format against the ranges the firmware validates
(frequency in kHz, bandwidth in Hz, the 3–168 hour and 60–240 minute advert windows) and
the failure paths: a board without GPS, a board that caps transmit power below 22 dBm,
and firmware too old for 2-byte paths. Each is reported to the user and skipped rather
than aborting the run. The wizard's step gate, which is what stands between a visitor and
writing firmware, is tested directly in `test/steps.test.mjs`.

## Deploy

Cloudflare Workers with static assets, same as the main site. No build step; the app is
plain HTML, CSS, and ES modules served as-is, plus the small Worker in `src/` for `/api/*`.

```sh
npm run deploy           # wrangler deploy
npm run deploy:preview   # wrangler versions upload
```

`name` in `wrangler.jsonc` must match the Cloudflare project slug or wrangler creates a
duplicate project on the next deploy. Security headers and cache policy live in
`public/_headers`; note that `Permissions-Policy` must keep `serial=(self)` and
`bluetooth=(self)` or the app cannot reach a radio.

## Credits

Standing on other people's work:

- **[MeshCore](https://github.com/meshcore-dev/MeshCore)** by Scott Powell / rippleradios.com
  (MIT). The mesh protocol and firmware this configures. Command codes and byte layouts
  here were read from `examples/companion_radio/MyMesh.cpp` and
  `src/helpers/CommonCLI.cpp`.
- **[config.meshcore.io](https://github.com/meshcore-dev/config.meshcore.io)** by Rastislav
  Vysoky (MIT). The original browser configurator and the direct inspiration for this one:
  it is where the browser-based-configurator idea and the shape of this whole tool come
  from, and its `lib/serial-cli.js` is what taught this project how a repeater frames CLI
  replies (the `  -> ` marker). No code from it remains here — MeshCore's device protocol
  moved on from the published JavaScript library, so the transport was rewritten against
  the firmware source.
- **[flasher.meshcore.io](https://github.com/meshcore-dev/flasher.meshcore.io)** by Rastislav
  Vysoky (MIT). The board catalogue is a snapshot of its `config.json`, the nRF52 DFU code
  is its `lib/dfu.js`, and the flashing sequence for both platforms follows it.
- **[esptool-js](https://github.com/espressif/esptool-js)** by Espressif (Apache-2.0), vendored
  unmodified for ESP32 flashing.
- **[meshcore.js](https://github.com/meshcore-dev/meshcore.js)** and the
  [companion protocol docs](https://docs.meshcore.io/companion_protocol/), used to
  cross-check the binary protocol.
- **[matcha.css](https://github.com/lowlighter/matcha)** by Lecoq Simon (MIT), the base
  styling the Liberty Hill palette is layered over in `public/css/style.css`.

## License

[MIT](LICENSE), the same license as MeshCore, config.meshcore.io, and matcha.css, so
anything here can flow back upstream freely.

Two carve-outs, spelled out in [`NOTICE`](NOTICE):

- The **Liberty Hill Mesh mark and favicon** are CC-BY-SA-4.0 and are not covered by the
  MIT grant. They identify this specific network. If you adapt this for your own mesh,
  swap them for your own.
- **`public/css/matcha.min.css`** is matcha.css, MIT © Lecoq Simon, with its license header
  intact.

Reusing this for your own mesh is the point: edit
[`public/config.json`](public/config.json), replace the brand assets, and it's yours.
