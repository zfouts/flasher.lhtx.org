/**
 * The board list is flasher.meshcore.io's config.json reduced by src/boards.js,
 * live through the Worker and as the offline fallback public/boards.json.
 * This pins the shape the page relies on and the reduction rules.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { reduceFlasherConfig, ROLES, FLASHER_CONFIG_URL } from '../src/boards.js';

const BOARDS = JSON.parse(readFileSync(new URL('../public/boards.json', import.meta.url), 'utf8'));

test('the live source is the file the flasher itself loads', () => {
  assert.equal(FLASHER_CONFIG_URL, 'https://flasher.meshcore.io/config.json');
});

test('the fallback catalogue records where it came from', () => {
  assert.equal(BOARDS.source.repo, 'meshcore-dev/flasher.meshcore.io');
  assert.match(BOARDS.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(BOARDS.source.url, `https://raw.githubusercontent.com/meshcore-dev/flasher.meshcore.io/${BOARDS.source.commit}/config.json`);
  assert.match(BOARDS.source.syncedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(BOARDS.roles, ROLES);
});

test('every board has a usable id, a platform, and compilable asset patterns per role', () => {
  assert.ok(BOARDS.boards.length >= 40, `${BOARDS.boards.length} boards`);
  const ids = new Set();
  for (const b of BOARDS.boards) {
    assert.match(b.id, /^[a-z0-9.-]+$/, b.name);
    assert.ok(!ids.has(b.id), `duplicate id ${b.id}`);
    ids.add(b.id);
    assert.ok(['esp32', 'nrf52'].includes(b.type), `${b.name}: type ${b.type}`);
    assert.ok(Object.keys(b.roles).length > 0, `${b.name}: no roles`);
    for (const [role, def] of Object.entries(b.roles)) {
      assert.ok(ROLES[role], `${b.name}: unknown role ${role}`);
      const kinds = Object.keys(def.files);
      if (b.type === 'esp32') assert.ok(kinds.includes('flash-wipe') && kinds.includes('flash-update'), `${b.name}/${role}: ${kinds}`);
      else assert.ok(kinds.includes('flash'), `${b.name}/${role}: ${kinds}`);
      for (const p of Object.values(def.files)) new RegExp(p);
    }
  }
});

test('the boards people actually bring to Liberty Hill Mesh are present with all four roles', () => {
  for (const name of ['Heltec v3', 'Heltec T114', 'RAK WisBlock / WisMesh (RAK 4631)', 'Seeed Studio SenseCAP T1000-E']) {
    const b = BOARDS.boards.find((x) => x.name === name);
    assert.ok(b, name);
    assert.deepEqual(Object.keys(b.roles).sort(), ['companionBle', 'companionUsb', 'repeater', 'roomServer'], name);
  }
});

test('reduceFlasherConfig keeps community GitHub firmware only, and the first of duplicate roles', () => {
  const config = {
    maker: { heltec: { name: 'Heltec' } },
    device: [
      { maker: 'heltec', name: 'Heltec v3', type: 'esp32', firmware: [
        { class: 'community', role: 'repeater', github: { type: 'repeater', files: { 'flash-wipe': 'a-merged\\.bin', 'flash-update': 'a\\.bin' } } },
        { class: 'community', role: 'repeater', subTitle: '[variant]', github: { type: 'repeater', files: { 'flash-wipe': 'b-merged\\.bin', 'flash-update': 'b\\.bin' } } },
        { class: 'ripple', role: 'gui', version: { 'v11.0': { files: [] } } },
        { class: 'community', role: 'kissRadio', version: {} },
        { class: 'community', role: 'companionUsb', github: { type: 'companion', files: { 'flash-wipe': 'c-merged\\.bin', 'flash-update': 'c\\.bin' } } },
      ] },
      { maker: 'heltec', name: 'Some Ripple-only thing', type: 'esp32', firmware: [{ class: 'ripple', role: 'gui', version: {} }] },
      { maker: 'x', name: 'Not flashable', type: 'noflash', firmware: [] },
    ],
  };
  const out = reduceFlasherConfig(config, { repo: 'r', commit: 'c', url: 'u', syncedAt: '2026-09-10' });
  assert.equal(out.boards.length, 1);
  assert.equal(out.boards[0].maker, 'Heltec');
  assert.equal(out.boards[0].id, 'heltec-v3');
  assert.deepEqual(Object.keys(out.boards[0].roles), ['repeater', 'companionUsb']);
  assert.equal(out.boards[0].roles.repeater.files['flash-wipe'], 'a-merged\\.bin', 'plain variant wins over "[variant]"');
});
