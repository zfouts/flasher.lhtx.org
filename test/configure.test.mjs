import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNodeName, versionAtLeast, pathHashBytes, MAX_NAME_BYTES } from '../public/js/configure.js';

test('node names the firmware would reject or truncate are caught with a specific reason', () => {
  assert.equal(validateNodeName('ATX-Zilker-1'), null);
  assert.equal(validateNodeName('  ATX  '), null, 'surrounding whitespace is trimmed');
  assert.match(validateNodeName(''), /name first/);
  assert.match(validateNodeName('   '), /name first/);

  // CommonCLI::isValidName: [ ] \ : , ? *
  for (const ch of ['[', ']', '\\', ':', ',', '?', '*']) {
    assert.match(validateNodeName(`ATX${ch}1`), /can't contain/, `"${ch}" should be rejected`);
  }

  assert.equal(validateNodeName('a'.repeat(MAX_NAME_BYTES)), null, 'exactly 31 bytes is fine');
  assert.match(validateNodeName('a'.repeat(MAX_NAME_BYTES + 1)), /32 characters.*at most 31/);
  // 12 chars but 14 bytes (en dash is 3 bytes), under the limit, still fine.
  assert.equal(validateNodeName('ATX–Zilker-1'), null);
  // Multibyte pushes it over: message must explain bytes ≠ characters.
  assert.match(validateNodeName('–'.repeat(11)), /bytes once encoded/);
});

test('versionAtLeast compares numerically, not lexically, and tolerates firmware suffixes', () => {
  assert.equal(versionAtLeast('v1.14.1', '1.14.0'), true);
  assert.equal(versionAtLeast('v1.14', '1.14.0'), true);
  assert.equal(versionAtLeast('v2.0.0', '1.14.0'), true);
  assert.equal(versionAtLeast('v1.13.9', '1.14.0'), false);
  assert.equal(versionAtLeast('v1.9.0', '1.14.0'), false, '9 < 14 numerically even though "9" > "1" lexically');
  assert.equal(versionAtLeast('v1.17.1 (Build: 14 Aug 2026)', '1.14.0'), true, 'ver output has a build suffix');
  assert.equal(versionAtLeast('', '1.14.0'), false);
  assert.equal(versionAtLeast('unknown', '1.14.0'), false);
});

test('path hash mode maps to the byte count shown to users', () => {
  assert.equal(pathHashBytes(0), 1);
  assert.equal(pathHashBytes(1), 2);
});
