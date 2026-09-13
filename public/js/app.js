/**
 * Wizard controller.
 *
 * Steps 1–3 flash: choose a board and role, review exactly which file will
 * be written and where it comes from, verify its hash, flash it.
 * Steps 4–5 configure: connect, then name the node, decide about GPS and press
 * the button. Everything else is fixed by PROFILE, so there is nothing else to
 * ask. Naming and configuring are one step because they are one decision.
 */

import { loadProfile } from './profile.js';
import { MeshPort } from './port.js';
import { BleTransport } from './ble.js';
import { CompanionClient } from './companion.js';
import { RepeaterClient, regionPutLine } from './repeater.js';
import { planCompanion, planRepeater, runPlan, validateNodeName, pathHashBytes } from './configure.js';
import { explainNoAnswer } from './diagnose.js';
import { detect } from './capability.js';
import {
  STEP, SLUG, STEP_BY_SLUG, SLUG_BY_STEP, reachable, nearestReachable, downloadIsCurrent,
} from './steps.js';
import {
  loadBoards, loadReleases, releasesForRole, pickAsset, downloadFirmware, formatBytes,
} from './firmware.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  step: 1,
  // flashing
  catalogue: null,   // boards.json
  releases: [],      // from /api/releases
  releasesSource: '',
  releasesNote: '',
  board: null,
  roleKey: '',
  fresh: true,
  install: '',
  release: null,
  asset: null,
  download: null,    // { bytes, sha256, verdict, upstream }
  flashedPort: null, // SerialPort reused for the connect step on ESP32
  // configuring
  transport: null,  // MeshPort | BleTransport
  kind: null,       // 'companion' | 'repeater'
  client: null,
  device: {},
  selfInfo: {},
  role: '',
  configured: false,
  cap: null,
};

// --- navigation -----------------------------------------------------------

/** Renders a step. Call goto() instead; this is what the URL triggers. */
function render(step) {
  state.step = step;
  $$('.step').forEach((el) => { el.hidden = Number(el.dataset.step) !== step; });
  $$('.rail li').forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle('is-current', n === step);
    el.classList.toggle('is-done', n < step);
    el.setAttribute('aria-current', n === step ? 'step' : 'false');
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Moves to a step by changing the URL, so every move lands in history and
 * back/forward walk the wizard. The hashchange handler does the rendering.
 */
function goto(step) {
  const slug = SLUG_BY_STEP[step];
  if (location.hash === `#/${slug}`) { render(step); return; }
  location.hash = `#/${slug}`;
}

/** Replaces the current entry instead of adding one, for corrections. */
function gotoReplacing(step) {
  const url = `${location.pathname}${location.search}#/${SLUG_BY_STEP[step]}`;
  history.replaceState(null, '', url);
  render(step);
}

function onRoute() {
  const slug = location.hash.replace(/^#\/?/, '');
  const asked = STEP_BY_SLUG[slug];
  if (!asked) { gotoReplacing(STEP.radio); return; }
  const allowed = nearestReachable(state, asked);
  if (allowed !== asked) { gotoReplacing(allowed); return; }
  render(allowed);
}

/**
 * Shows a failure in a box. Accepts a plain string, or an object with
 * `message`, `hints` (things to try) and `detail` (what was observed, for
 * anyone reporting the problem).
 */
function showProblem(box, problem) {
  box.replaceChildren();
  const { message, hints = [], detail = '' } = typeof problem === 'string' ? { message: problem } : problem;

  const p = document.createElement('p');
  p.append(document.createElement('strong'));
  p.firstChild.textContent = message;
  box.append(p);

  if (hints.length) {
    const ul = document.createElement('ul');
    for (const hint of hints) {
      const li = document.createElement('li');
      li.textContent = hint;
      ul.append(li);
    }
    box.append(ul);
  }
  if (detail) {
    const small = document.createElement('p');
    small.className = 'muted detail';
    small.textContent = detail;
    box.append(small);
  }
  box.hidden = false;
}

const fail = (problem) => showProblem($('#connect-error'), problem);

/** Fills a <dl> from [term, value] pairs; a value may be a Node. */
function renderKv(dl, rows) {
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    if (v instanceof Node) dd.append(v); else dd.textContent = v;
    dl.append(dt, dd);
  }
}

function link(href, text = href) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

/** "2026-09-10 14:17 UTC" from an ISO timestamp. */
function stamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function mono(text) {
  const code = document.createElement('code');
  code.className = 'hash';
  code.textContent = text;
  return code;
}

// --- step 1: choose radio ---------------------------------------------------

/**
 * Filters the board list by substring, so "T1" narrows to the T114 rather
 * than making someone scroll 56 options. Keeps the current selection if it
 * still matches, and says how many are showing.
 */
function applyBoardFilter() {
  const q = $('#board-filter').value.trim().toLowerCase();
  const select = $('#board');
  const chosen = select.value;
  let shown = 0;
  let total = 0;
  for (const opt of select.options) {
    if (!opt.value) continue;                    // the "choose a board" prompt
    total += 1;
    const hit = !q || opt.textContent.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q);
    opt.hidden = !hit;
    if (hit) shown += 1;
  }
  const count = $('#board-filter-count');
  if (!q) count.textContent = `${total} boards. Type to narrow the list.`;
  else if (shown === 0) count.textContent = `Nothing matches "${$('#board-filter').value.trim()}".`;
  else count.textContent = shown === 1 ? '1 board matches.' : `${shown} boards match.`;

  // If the selection was filtered away, fall to the first visible one.
  const current = [...select.options].find((o) => o.value === chosen);
  if (q && shown && (!current || current.hidden)) {
    const first = [...select.options].find((o) => o.value && !o.hidden);
    if (first) { select.value = first.value; onRadioChoiceChanged(); }
  }
}

function renderBoards() {
  const select = $('#board');
  select.replaceChildren();
  const byMaker = new Map();
  for (const b of state.catalogue.boards) {
    if (!byMaker.has(b.maker)) byMaker.set(b.maker, []);
    byMaker.get(b.maker).push(b);
  }
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a board…';
  select.append(placeholder);
  for (const [maker, boards] of [...byMaker].sort((a, b) => a[0].localeCompare(b[0]))) {
    const group = document.createElement('optgroup');
    group.label = maker;
    for (const b of boards) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.name;
      group.append(opt);
    }
    select.append(group);
  }
  $('#boards-provenance').replaceChildren(...boardsProvenance());
}

/** Where the board list came from, as inline nodes for the hint and the review screen. */
function boardsProvenance() {
  const { source, live, liveError } = state.catalogue;
  if (live) {
    const when = source.lastModified ? `, last changed ${new Date(source.lastModified).toISOString().slice(0, 10)}` : '';
    return ['fetched from ', link(source.url), ` ${stamp(source.fetchedAt)} (refreshed hourly)${when}`];
  }
  return [
    `live fetch failed (${liveError}); using the fallback snapshot `,
    link(`https://github.com/${source.repo}/blob/${source.commit}/config.json`, `${source.commit.slice(0, 7)} from ${source.syncedAt}`),
  ];
}

function selectedRole() {
  return document.querySelector('input[name="role"]:checked')?.value ?? '';
}

function onRadioChoiceChanged() {
  // Any change here invalidates a review: the asset was picked for the old
  // choice, and so were the bytes already downloaded and verified against it.
  // Leaving them in place would let history navigation reach the flash step
  // and write the previous board's firmware to the one now selected.
  state.asset = null;
  state.download = null;
  $('#btn-flash-go').disabled = true;

  state.board = state.catalogue?.boards.find((b) => b.id === $('#board').value) ?? null;
  const roles = state.board?.roles ?? {};

  // Only roles this board has firmware for.
  for (const input of $$('input[name="role"]')) {
    const available = !!roles[input.value];
    input.disabled = !available;
    input.closest('.role-option').classList.toggle('is-unavailable', !available);
    if (!available && input.checked) input.checked = false;
  }
  state.roleKey = selectedRole();

  const isEsp = state.board?.type === 'esp32';
  $('#install-set').hidden = !state.board || !isEsp;
  $('#install-nrf-note').hidden = !state.board || isEsp;
  state.fresh = isEsp ? document.querySelector('input[name="install"]:checked')?.value !== 'update' : true;

  renderVersions();
  renderOfficialCard();
  // Reviewing needs no hardware, only a board, a role and a version. Web Serial
  // is checked at the flash step, where it is actually used.
  $('#btn-review').disabled = !(state.board && state.roleKey && state.release);
}

function renderVersions() {
  const select = $('#version');
  select.replaceChildren();
  const list = releasesForRole(state.releases, state.catalogue?.roles ?? {}, state.roleKey);
  for (const r of list) {
    const opt = document.createElement('option');
    opt.value = r.tag;
    opt.textContent = `${r.version}${r === list[0] ? ' (latest)' : ''} · ${(r.publishedAt ?? '').slice(0, 10)}`;
    select.append(opt);
  }
  select.disabled = list.length === 0;
  state.release = list.find((r) => r.tag === select.value) ?? list[0] ?? null;
  $('#version-hint').textContent = (state.roleKey
    ? (list.length ? `${list.length} releases of this firmware on GitHub.` : 'No releases found for this role.')
    : 'Pick a role to see versions.') + (state.releasesNote ? ` ${state.releasesNote}` : '');
}

/** flasher.meshcore.io routes as /<board-slug>/<role-slug>/, using the same slug rule as boards.json ids. */
function officialFlasherUrl() {
  const roleSlug = {
    companionUsb: 'companion-usb',
    companionBle: 'companion-bluetooth',
    repeater: 'repeater',
    roomServer: 'room-server',
  }[state.roleKey];
  let url = 'https://flasher.meshcore.io/';
  if (state.board) url += `${state.board.id}/`;
  if (state.board && roleSlug) url += `${roleSlug}/`;
  return url;
}

function renderOfficialCard() {
  $('#official-link').href = officialFlasherUrl();
  renderKv($('#official-settings'), [
    ['Frequency', `${PROFILE.radio.freqMHz} MHz`],
    ['Bandwidth', `${PROFILE.radio.bwKHz} kHz`],
    ['Spreading factor', String(PROFILE.radio.sf)],
    ['Coding rate', String(PROFILE.radio.cr)],
    ['Transmit power', `${PROFILE.txPowerDbm} dBm`],
    ['Path hash mode', `${PROFILE.pathHashMode} (${pathHashBytes(PROFILE.pathHashMode)}-byte)`],
    ['Flood advert interval', `${PROFILE.floodAdvertHours} hours (repeaters)`],
    ['Zero-hop advert interval', `${PROFILE.zeroHopAdvertMinutes} minutes (repeaters)`],
  ]);
  $('#official-cli').textContent = [
    `set radio ${PROFILE.radio.freqMHz},${PROFILE.radio.bwKHz},${PROFILE.radio.sf},${PROFILE.radio.cr}`,
    `set tx ${PROFILE.txPowerDbm}`,
    `set path.hash.mode ${PROFILE.pathHashMode}`,
    `set flood.advert.interval ${PROFILE.floodAdvertHours}`,
    `set advert.interval ${PROFILE.zeroHopAdvertMinutes}`,
    'reboot',
  ].join('\n');
}

// --- step 2: review ---------------------------------------------------------

function roleTitle(roleKey) {
  return state.catalogue?.roles?.[roleKey]?.title ?? roleKey;
}

/**
 * One table, filled in as we learn things, instead of a "what we will fetch"
 * list and a near-identical "what we got" list. The four rows here are what
 * decides whether to flash; everything about relays, hosts and where the hash
 * was published is provenance and folds away.
 */
function renderReviewTable() {
  const { asset, release, download } = state;

  let integrity;
  if (!download) {
    integrity = 'Not checked yet. Press the button below.';
  } else {
    const status = download.verdict.status;
    const verdict = document.createElement('strong');
    verdict.className = `verdict is-${status}`;
    verdict.textContent = {
      match: 'Verified: the bytes match the hash GitHub published.',
      mismatch: 'MISMATCH. These bytes will not be flashed.',
      unverifiable: 'Cannot verify: GitHub published no hash for this file.',
    }[status];
    integrity = verdict;
  }

  renderKv($('#review-file'), [
    ['File', (() => { const f = document.createDocumentFragment();
      f.append(mono(asset.name), ` · ${formatBytes(asset.size)}`); return f; })()],
    ['Version', (() => { const f = document.createDocumentFragment();
      f.append(release.publishedAt ? `${release.version}, published ${release.publishedAt.slice(0, 10)} · ` : `${release.version} · `);
      f.append(link(release.url, 'release page')); return f; })()],
    ['Install', state.install],
    ['Integrity', integrity],
  ]);

  const boardList = document.createElement('span');
  boardList.append(...boardsProvenance());
  renderKv($('#provenance'), [
    ['Downloaded from', link(asset.upstream)],
    ['Via', document.createRange().createContextualFragment(
      `this site's relay at <code class="hash">${asset.proxy}</code>, because github.com refuses direct browser downloads. It passes the bytes through unchanged.`,
    )],
    ...(download?.finalUrl ? [['Served by', new URL(download.finalUrl).host]] : []),
    ['Published SHA-256', asset.sha256 ? mono(asset.sha256) : 'not published by GitHub for this file'],
    ...(download ? [['Computed SHA-256', mono(download.sha256)]] : []),
    ['Hash published at', link(state.releasesSource, 'GitHub releases API')],
    ['Board list', boardList],
  ]);
}

function review() {
  state.asset = pickAsset(state.board, state.roleKey, state.release, { fresh: state.fresh });
  state.download = null;
  if (!state.asset) {
    showProblem($('#catalogue-error'), `${state.release.version} has no ${roleTitle(state.roleKey)} image for ${state.board.name}. Try another version.`);
    return;
  }
  $('#catalogue-error').hidden = true;

  const { asset, board, release } = state;
  $('#review-role').textContent = roleTitle(state.roleKey);
  $('#review-board').textContent = board.name;
  $('#review-version').textContent = `MeshCore ${release.version}`;

  state.install = board.type === 'esp32'
    ? (state.fresh ? 'Fresh install: full image at address 0x0, erasing the whole flash first' : 'Update: app image at address 0x10000, flash not erased')
    : 'nRF52 DFU package: the bootloader replaces the app region only';
  renderReviewTable();

  renderNotes(release.notes);

  $('#verify-error').hidden = true;
  $('#download-progress').hidden = true;
  $('#download-status').textContent = '';
  $('#btn-download').disabled = false;
  $('#btn-flash-go').disabled = true;
  goto(STEP.firmware);
}

async function downloadAndVerify() {
  const { asset } = state;
  $('#btn-download').disabled = true;
  $('#verify-error').hidden = true;
  const bar = $('#download-progress');
  bar.hidden = false;
  bar.value = 0;
  $('#download-status').textContent = 'Downloading…';

  try {
    const result = await downloadFirmware(asset, (received, total) => {
      bar.value = total ? Math.round((received / total) * 100) : 0;
      $('#download-status').textContent = `Downloading… ${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ''}`;
    });
    $('#download-status').textContent = 'Hashing…';
    // Tie the bytes to the choice they were fetched for; `reachable()` refuses
    // the flash step once the selection moves on (see steps.js).
    state.download = { ...result, asset };

    renderReviewTable();
    $('#download-status').textContent = '';

    if (result.verdict.ok) {
      $('#btn-flash-go').disabled = false;
    } else {
      showProblem($('#verify-error'), {
        message: result.verdict.reason,
        hints: ['Try the download again. If it fails the same way twice, report it with the two hashes above.'],
      });
      $('#btn-flash-go').disabled = true;
      $('#btn-download').disabled = false;
    }
  } catch (err) {
    $('#download-status').textContent = '';
    showProblem($('#verify-error'), { message: err.message });
    $('#btn-download').disabled = false;
  } finally {
    bar.hidden = true;
  }
}

// --- step 3: flash ----------------------------------------------------------

/**
 * Release notes are plain text from GitHub. Linkify bare URLs so the blog
 * link people are pointed at is actually clickable, escaping everything
 * else, since this is upstream text.
 */
function renderNotes(notes) {
  const pre = $('#review-notes');
  pre.replaceChildren();
  const text = notes || 'No notes on this release.';
  const re = /https?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:]/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) pre.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.href = m[0];
    a.textContent = m[0];
    a.target = '_blank';
    a.rel = 'noopener';
    pre.append(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) pre.append(text.slice(last));
}

function showFlashStep() {
  const isEsp = state.board.type === 'esp32';
  $('#flash-howto-esp32').hidden = !isEsp;
  $('#flash-howto-nrf52').hidden = isEsp;
  $('#btn-dfu').hidden = isEsp;
  $('#btn-flash').disabled = false;
  $('#flash-progress').hidden = true;
  $('#flash-log').hidden = true;
  $('#flash-log').textContent = '';
  $('#flash-error').hidden = true;
  $('#flash-done').hidden = true;
  $('#flash-status').textContent = '';
  goto(STEP.flash);
}

async function enterDfu() {
  $('#flash-error').hidden = true;
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: [] });
  } catch (err) {
    if (err.name !== 'NotFoundError') showProblem($('#flash-error'), err.message);
    return;
  }
  $('#btn-dfu').disabled = true;
  $('#flash-status').textContent = 'Rebooting into DFU…';
  try {
    const { enterDfuMode } = await import('./flash.js');
    await enterDfuMode(port);
    $('#flash-status').textContent = 'DFU mode requested. Now press Flash and pick the new port.';
  } catch (err) {
    showProblem($('#flash-error'), { message: `Could not put the radio into DFU mode: ${err.message}`, hints: ['Press its reset button twice quickly instead, then press Flash.'] });
  } finally {
    $('#btn-dfu').disabled = false;
  }
}

async function flash() {
  if (!downloadIsCurrent(state)) {
    showProblem($('#flash-error'), 'This firmware has not been verified for the board you have selected. Go back and download it again.');
    return;
  }
  $('#flash-error').hidden = true;
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: [] });
  } catch (err) {
    if (err.name !== 'NotFoundError') showProblem($('#flash-error'), err.message);
    return;
  }

  const bar = $('#flash-progress');
  const log = $('#flash-log');
  $('#btn-flash').disabled = true;
  $('#btn-dfu').disabled = true;
  bar.hidden = false;
  bar.value = 0;
  $('#flash-status').textContent = 'Connecting…';
  const onProgress = (written, total) => {
    bar.value = total ? Math.round((written / total) * 100) : 0;
    $('#flash-status').textContent = `Writing… ${bar.value}%`;
  };

  try {
    const { flashEsp32, flashNrf52 } = await import('./flash.js');
    if (state.board.type === 'esp32') {
      log.hidden = false;
      const { chip } = await flashEsp32({
        port,
        bytes: state.download.bytes,
        address: state.asset.address,
        eraseAll: state.fresh,
        onProgress,
        onLog: (line) => { log.textContent += line; log.scrollTop = log.scrollHeight; },
      });
      $('#flash-status').textContent = `Done (${chip}).`;
      state.flashedPort = port;
    } else {
      await flashNrf52({ port, zipBytes: state.download.bytes, onProgress });
      $('#flash-status').textContent = 'Done.';
      state.flashedPort = null; // it re-enumerates after DFU
    }
    bar.value = 100;
    const ble = state.roleKey === 'companionBle';
    $('#flash-next-usb').hidden = ble;
    $('#flash-next-ble').hidden = !ble;
    $('#flash-done').hidden = false;
  } catch (err) {
    showProblem($('#flash-error'), {
      message: err.message,
      hints: state.board.type === 'esp32'
        ? ['Unplug the radio, hold BOOT while plugging it back in, and press Flash again.', 'Make sure nothing else has the port open.']
        : ['Make sure the radio is in DFU mode (double-tap reset) and pick the port that appeared after it rebooted.'],
    });
    $('#btn-flash').disabled = false;
    $('#btn-dfu').disabled = false;
    $('#flash-status').textContent = '';
  }
}

// --- step 4: connecting -----------------------------------------------------

/**
 * A radio speaks either the companion binary protocol or the repeater text
 * CLI, never both, and nothing announces which. Probe for companion first
 * because it answers in a single frame, then fall back to the CLI.
 */
async function detectOverSerial(port) {
  // Boards with a USB-UART bridge reset when the port opens; let the boot
  // log finish before probing, or the probes land on a bootloader.
  await port.settle();

  const companion = new CompanionClient({
    sendPayload: (bytes) => port.sendFrame(bytes),
    takeFrame: () => port.takeFrame(),
    clearFrames: () => port.clearFrames(),
  });

  // Two attempts: ESP32-S3 native-USB boards reset when the port opens and
  // may still be booting when the first probe lands.
  let device = null;
  for (let attempt = 0; attempt < 2 && !device; attempt++) {
    try {
      device = await companion.deviceQuery({ timeout: 1500 });
    } catch {
      // Not (yet) answering as a companion.
    }
  }
  if (device) {
    // Past the probe, failures are real and should be shown, not masked by
    // a doomed CLI attempt on companion firmware.
    const selfInfo = await companion.appStart();
    return { kind: 'companion', client: companion, device, selfInfo };
  }

  const repeater = new RepeaterClient(port);
  try {
    // The probe bytes are sitting in the repeater's line buffer; flush them.
    await repeater.flushLine();
    const role = await repeater.getRole({ timeout: 3000 });
    const version = await repeater.getVersion();
    return {
      kind: 'repeater',
      client: repeater,
      role,
      device: { firmwareVersion: (version.match(/v?\d+\.\d+(\.\d+)?/) ?? [''])[0] },
    };
  } catch {
    const problem = explainNoAnswer({
      rxBytes: port.rxBytes,
      excerpt: port.rxExcerpt(),
      usbId: port.usbId(),
    });
    throw Object.assign(new Error(problem.message), { problem });
  }
}

async function connectSerial() {
  $('#connect-error').hidden = true;
  let port;
  const reusing = Boolean(state.flashedPort);
  try {
    // A radio flashed a moment ago over this same port needs no picker.
    port = reusing ? new MeshPort(state.flashedPort) : await MeshPort.request();
  } catch (err) {
    // NotFoundError means no port was chosen. Usually that is someone closing
    // the picker, but it is the same error when the picker never opened, and
    // saying nothing there leaves them staring at a button that did nothing.
    if (err.name === 'NotFoundError') {
      fail({
        message: 'No radio was picked.',
        hints: [
          'If a window listing devices appeared, choose the radio in it and press Connect.',
          'If no window appeared at all, the browser blocked it. Check the address bar for a blocked-popup or permission icon, and make sure this tab is the active one.',
          'Firefox and Safari cannot show that window at all. Use Chrome, Edge or Opera on a desktop.',
        ],
        detail: `browser: ${navigator.userAgent}`,
      });
    } else {
      fail(err.message);
    }
    return;
  }

  setBusy(true, 'Talking to the radio…');
  try {
    await port.open();
    const found = await detectOverSerial(port);
    port.onDisconnect = handleDisconnect;
    adopt(port, found);
  } catch (err) {
    await port.close().catch(() => {});
    const hadReused = reusing;
    state.flashedPort = null; // next attempt goes through the picker
    const problem = err.problem ?? { message: err.message };
    if (hadReused) {
      const p2 = typeof problem === 'string' ? { message: problem } : problem;
      p2.hints = [...(p2.hints ?? []), 'That used the port from flashing without asking again. Press Connect over USB once more and pick the radio yourself.'];
      fail(p2);
    } else {
      fail(problem);
    }
  } finally {
    setBusy(false);
  }
}

async function connectBle() {
  $('#connect-error').hidden = true;
  let transport;
  try {
    transport = await BleTransport.request();
  } catch (err) {
    if (err.name !== 'NotFoundError') fail(err.message);
    return;
  }

  setBusy(true, 'Pairing…');
  try {
    await transport.open();
    const client = new CompanionClient(transport);
    const device = await client.deviceQuery({ timeout: 4000 });
    const selfInfo = await client.appStart();
    transport.onDisconnect = handleDisconnect;
    adopt(transport, { kind: 'companion', client, device, selfInfo });
  } catch (err) {
    await transport.close().catch(() => {});
    fail(
      /did not respond/.test(err.message)
        ? "Paired, but the radio didn't answer. Bluetooth needs companion firmware. Repeaters and room servers have to be set up over USB."
        : err.message,
    );
  } finally {
    setBusy(false);
  }
}

function adopt(transport, found) {
  Object.assign(state, {
    transport,
    kind: found.kind,
    client: found.client,
    device: found.device ?? {},
    selfInfo: found.selfInfo ?? {},
    role: found.role ?? '',
  });

  renderDevice();
  renderSettingsInto($('#settings-list'), state.kind);
  renderRegionField(state.kind);

  const input = $('#node-name');
  if (!input.value && state.selfInfo.name) input.value = state.selfInfo.name;
  refreshCommands();
  goto(STEP.configure);
  input.focus();
}

function handleDisconnect() {
  if (state.step === STEP.done) return; // finished; the radio rebooting is expected
  state.transport = state.client = null;
  fail('The radio disconnected. Plug it back in and start again.');
  goto(STEP.connect);
}

/**
 * A Companion BLE build has no USB interface compiled in, so offering
 * "Connect over USB" first on a radio we just flashed with it is a dead end.
 * Lead with the one that can work.
 */
function preferConnection() {
  const cap = state.cap;
  const note = $('#connect-preferred');
  if (cap && !(cap.canSerial && cap.canBle)) { if (note) note.hidden = true; return; }
  const wantsBle = state.roleKey === 'companionBle';
  const serial = $('#btn-serial');
  const ble = $('#btn-ble');
  if (!serial || !ble) return;
  serial.classList.toggle('primary', !wantsBle);
  ble.classList.toggle('primary', wantsBle);
  if (!note) return;
  if (!state.roleKey) { note.hidden = true; return; }
  note.hidden = false;
  note.textContent = wantsBle
    ? 'You flashed Companion Bluetooth firmware, which has no USB interface. Use Bluetooth.'
    : 'You flashed firmware that talks over USB. Use the cable.';
  if (wantsBle) ble.parentNode.insertBefore(ble, serial);
  else serial.parentNode.insertBefore(serial, ble);
}

function renderDevice() {
  const { device, kind, role } = state;
  $('#device-role').textContent = kind === 'companion'
    ? 'Companion'
    : (role ? role.replace(/^\w/, (c) => c.toUpperCase()) : 'Repeater');
  $('#device-model').textContent = device.manufacturer || 'MeshCore radio';
  $('#device-firmware').textContent = device.firmwareVersion ? `firmware ${device.firmwareVersion}` : '';
}

// --- rendering ------------------------------------------------------------

/** The settings rows for a firmware kind ('companion' | 'repeater'), derived from PROFILE. */
function settingsRows(kind) {
  const rows = [
    ['Region preset', `${PROFILE.label}: ${PROFILE.summary}`],
    ['Transmit power', `${PROFILE.txPowerDbm} dBm`],
    ['Path hashes', `${pathHashBytes(PROFILE.pathHashMode)}-byte (path.hash.mode ${PROFILE.pathHashMode})`],
  ];
  if (kind === 'repeater') {
    rows.push(['Advert to whole mesh', `every ${PROFILE.floodAdvertHours} hours`]);
    rows.push(['Advert to neighbors', `every ${PROFILE.zeroHopAdvertMinutes} minutes`]);
  } else {
    rows.push(['Adverts', 'sent on demand; companions have no timer']);
  }
  rows.push(['Clock', 'synced from this computer']);
  return rows;
}

function renderSettingsInto(dl, kind) {
  renderKv(dl, settingsRows(kind));
}

/**
 * The commands the configure step will send, so the screen and the radio
 * cannot disagree. Repeaters take CLI lines; companions take binary frames,
 * which are described rather than quoted because there is no text to paste.
 */
/** The region lines the plan will send, or nothing when it is not switched on. */
function regionCommands(enabled) {
  if (!enabled || !PROFILE.regions.length) return [];
  return [...PROFILE.regions.map(regionPutLine), 'region save'];
}

function renderConfigureCommands(kind, name, gps, regions) {
  const pre = $('#configure-commands');
  const label = name || '<your node name>';
  if (kind === 'repeater') {
    pre.textContent = [
      `set name ${label}`,
      `set radio ${PROFILE.radio.freqMHz},${PROFILE.radio.bwKHz},${PROFILE.radio.sf},${PROFILE.radio.cr}`,
      `set tx ${PROFILE.txPowerDbm}`,
      `set path.hash.mode ${PROFILE.pathHashMode}`,
      `set flood.advert.interval ${PROFILE.floodAdvertHours}`,
      `set advert.interval ${PROFILE.zeroHopAdvertMinutes}`,
      gps ? 'set gps 1' : 'set gps 0',
      ...regionCommands(regions),
      'set time <this computer\u2019s clock>',
      'reboot',
    ].join('\n');
  } else {
    pre.textContent = [
      `name          ${label}`,
      `radio         ${PROFILE.radio.freqMHz} MHz, BW ${PROFILE.radio.bwKHz}, SF ${PROFILE.radio.sf}, CR ${PROFILE.radio.cr}`,
      `tx power      ${PROFILE.txPowerDbm} dBm`,
      `path.hash     mode ${PROFILE.pathHashMode} (${pathHashBytes(PROFILE.pathHashMode)}-byte)`,
      `gps           ${gps ? 'on, and adverts carry position' : 'left off'}`,
      'clock         synced from this computer',
    ].join('\n');
  }
}

function renderRegions() {
  $('#region-others').innerHTML = PROFILE.otherRegions
    .map((r) => `<li><span>${escapeHtml(r.label)}</span> <span class="muted">${escapeHtml(r.summary)}</span></li>`)
    .join('');
}

const ICONS = { pending: '○', running: '◐', done: '●', skipped: '◌', failed: '✕' };

/**
 * The region opt-in, shown only where it can do anything: a repeater or room
 * server, on a config that defines regions. Off by default -- regions change
 * how far traffic travels, which is a decision for whoever runs the node.
 */
function renderRegionField(kind) {
  const field = $('#regions-field');
  if (!field) return;
  const offer = kind === 'repeater' && PROFILE.regions.length > 0;
  field.hidden = !offer;
  if (!offer) { $('#regions-enabled').checked = false; return; }
  $('#regions-hint').textContent =
    `Scopes how far this repeater forwards traffic: ${PROFILE.regions.map((r) => r.name).join(' \u00b7 ')}. `
    + 'Traffic cascades down from a parent region to its children, while local traffic on a child is not pushed back up. '
    + 'This adds regions; anything already on the radio is left alone and named in the result. '
    + 'Firmware without region support skips it.';
}

/** Keeps the quoted commands in step with what the form currently says. */
function refreshCommands() {
  if (!state.kind) return;
  renderConfigureCommands(state.kind, $('#node-name').value.trim(), $('#gps-enabled').checked, $('#regions-enabled').checked);
}

/**
 * Hides what this browser cannot do and says why in its place, so nobody
 * clicks a control that was never going to work.
 */
function applyCapability(cap) {
  // Every lookup is guarded. This runs against whatever HTML the browser has
  // cached, which is not always the HTML this file shipped with, and a missing
  // element must not be allowed to throw: everything after this point,
  // including the click handlers, would never be wired up.
  const say = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  const hide = (id, value) => { const el = $(id); if (el) el.hidden = value; };

  // Top of page: only shout when nothing at all can be reached.
  hide('#unsupported', cap.level !== 'none');
  say('#unsupported-reason', cap.reason);
  say('#unsupported-advice', cap.advice);
  hide('#browser-note', cap.level === 'none');

  // The banner at the top of the page is always on screen, so when it is
  // showing there is no point repeating it inside each step.
  const banner = cap.level === 'none';

  // Flashing needs Web Serial.
  hide('#btn-flash', !cap.canFlash);
  hide('#btn-dfu', !cap.canFlash);
  hide('#flash-unsupported', cap.canFlash || banner);
  say('#flash-unsupported-reason', cap.reason);
  say('#flash-unsupported-advice', cap.advice);

  // Connecting needs one transport or the other. Remove the ones that cannot
  // work so the step offers only real options, or none with an explanation.
  hide('#btn-serial', !cap.canSerial);
  hide('#btn-ble', !cap.canBle);
  const noTransport = !cap.canSerial && !cap.canBle;
  hide('#connect-unsupported', !noTransport || banner);
  say('#connect-unsupported-reason', cap.reason);
  say('#connect-unsupported-advice', cap.advice);
  hide('#connect-partial', noTransport || cap.level === 'full');
  say('#connect-partial-text', cap.advice);
}

function renderProgress(results) {
  $('#progress-list').innerHTML = results
    .map((r) => `
      <li class="is-${r.status}">
        <span class="progress-icon" aria-hidden="true">${ICONS[r.status]}</span>
        <span>
          <span class="progress-label">${escapeHtml(r.label)}</span>
          ${r.detail ? `<span class="progress-detail">${escapeHtml(r.detail)}</span>` : ''}
        </span>
      </li>`)
    .join('');
}

// --- applying -------------------------------------------------------------

async function apply() {
  const name = $('#node-name').value.trim();
  const problem = validateNodeName(name);
  if (problem) {
    $('#name-error').textContent = problem;
    $('#name-error').hidden = false;
    $('#node-name').focus();
    return;
  }
  $('#name-error').hidden = true;

  const inputs = { name, gps: $('#gps-enabled').checked, device: state.device };
  $('#progress-error').hidden = true;
  $('#progress-retry').hidden = true;
  $('#progress-list').hidden = false;
  $('#btn-apply').disabled = true;
  $('#progress-list').scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  const steps = state.kind === 'companion'
    ? planCompanion(state.client, { ...inputs, selfInfo: state.selfInfo, profile: PROFILE })
    : planRepeater(state.client, { ...inputs, profile: PROFILE, regions: $('#regions-enabled').checked });

  try {
    finish(await runPlan(steps, renderProgress), inputs);
  } catch (err) {
    $('#progress-error').textContent = err.message;
    $('#progress-error').hidden = false;
    $('#progress-retry').hidden = false;
    $('#btn-apply').disabled = false;
  }
}

function finish(results, inputs) {
  const skipped = results.filter((r) => r.status === 'skipped' && r.detail);

  $('#done-name').textContent = inputs.name;
  $('#done-settings').textContent = PROFILE.summary;
  $('#done-hash').textContent = `${pathHashBytes(PROFILE.pathHashMode)}-byte`;
  $('#done-notes').innerHTML = skipped
    .map((r) => `<li>${escapeHtml(r.label)}: ${escapeHtml(r.detail)}</li>`)
    .join('');
  $('#done-notes-wrap').hidden = skipped.length === 0;
  $('#done-repeater-note').hidden = state.kind !== 'repeater';

  state.configured = true;
  goto(STEP.done);
  // Release the port so the MeshCore app can connect to the radio next.
  state.transport?.close().catch(() => {});
}

// --- helpers --------------------------------------------------------------

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setBusy(busy, message = '') {
  $('#connect-busy').hidden = !busy;
  $('#connect-busy-text').textContent = message;
  $$('.connect-button').forEach((b) => { b.disabled = busy; });
}

// --- boot -----------------------------------------------------------------

/** Fills in every element carrying a data-config key, so a fork only edits JSON. */
function renderBranding() {
  const values = {
    'network.name': PROFILE.network.name,
    'network.site': PROFILE.network.site,
    'network.guide': PROFILE.network.guide,
  };
  for (const el of $$('[data-config]')) {
    const value = values[el.dataset.config];
    if (!value) continue;
    if (el instanceof HTMLAnchorElement) el.href = value;
    if (el.dataset.configText !== undefined) el.textContent = value;
  }
}

let PROFILE;
try {
  PROFILE = await loadProfile();
} catch (err) {
  // Nothing below can run without a valid config, so say so plainly.
  document.querySelector('main').innerHTML =
    `<h1>Configuration problem</h1>
     <div id="connect-error" role="alert">${escapeHtml(err.message)}</div>
     <p class="muted">This is a problem with the site, not your radio.
     <code>config.json</code> failed to load or did not pass validation.</p>`;
  throw err;
}

renderBranding();
renderRegions();
renderOfficialCard();

/* Only the steps that actually touch hardware are gated. Choosing a board,
   reviewing the firmware, verifying its hash and reading the settings all
   work anywhere, so a phone or Safari can still be used to check what this
   tool would do. A button that cannot possibly work is removed rather than
   greyed out: a disabled control invites clicking and explains nothing. */
// Capability is worked out after the handlers below are wired, so a fault
// here can never leave the page with dead buttons.

$('#board').addEventListener('change', onRadioChoiceChanged);
$('#board-filter').addEventListener('input', applyBoardFilter);
$$('input[name="role"], input[name="install"]').forEach((el) => el.addEventListener('change', onRadioChoiceChanged));
$('#version').addEventListener('change', () => {
  state.release = state.releases.find((r) => r.tag === $('#version').value) ?? null;
});
$('#btn-review').addEventListener('click', review);
$('#btn-skip-flash').addEventListener('click', () => { state.roleKey = state.roleKey || ''; preferConnection(); goto(STEP.connect); });
$('#btn-goto-flash').addEventListener('click', () => goto(STEP.radio));
$('#btn-download').addEventListener('click', downloadAndVerify);
$('#btn-review-back').addEventListener('click', () => goto(STEP.radio));
$('#btn-flash-go').addEventListener('click', showFlashStep);
$('#btn-dfu').addEventListener('click', enterDfu);
$('#btn-flash').addEventListener('click', flash);
$('#btn-flash-continue').addEventListener('click', () => { preferConnection(); goto(STEP.connect); });
$('#btn-serial').addEventListener('click', connectSerial);
$('#btn-ble').addEventListener('click', connectBle);
$('#btn-apply').addEventListener('click', apply);
$('#progress-retry').addEventListener('click', () => {
  $('#progress-list').hidden = true;
  $('#progress-error').hidden = true;
  $('#progress-retry').hidden = true;
  $('#btn-apply').disabled = false;
});
$('#btn-restart').addEventListener('click', () => {
  window.location.href = `${location.pathname}${location.search}#/${SLUG.radio}`;
  window.location.reload();
});
$('#node-name').addEventListener('input', () => { $('#name-error').hidden = true; refreshCommands(); });
$('#gps-enabled').addEventListener('change', refreshCommands);
$('#regions-enabled').addEventListener('change', refreshCommands);

$('#btn-review').disabled = true;
window.addEventListener('hashchange', onRoute);
onRoute();   // honour a deep link, or fall back to the first step

try {
  state.cap = await detect();
  applyCapability(state.cap);
} catch (err) {
  // Worst case the browser warning stays as the markup left it, which errs
  // towards telling someone their browser cannot do this. The wizard itself
  // is already wired and works.
  console.error('capability check failed', err);
}

// The catalogue and releases load after the page is usable; the connect
// path never depends on them.
try {
  const [catalogue, releases] = await Promise.all([loadBoards(), loadReleases()]);
  state.catalogue = catalogue;
  state.releases = releases.releases;
  state.releasesSource = releases.source;
  state.releasesNote = releases.fetchedAt ? `List fetched from GitHub ${stamp(releases.fetchedAt)}; it refreshes hourly.` : '';
  renderBoards();
  applyBoardFilter();
  onRadioChoiceChanged();
} catch (err) {
  showProblem($('#catalogue-error'), {
    message: `The firmware list could not be loaded: ${err.message}`,
    hints: ['You can still flash at flasher.meshcore.io and come back to configure, or skip straight to connecting.'],
  });
  $('#board').disabled = true;
}
