import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../public/js/capability.js';

const UA = {
  chromeDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edgeDesktop:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  operaDesktop:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0',
  firefox:       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0',
  safari:        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  chromeIos:     'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
  safariIos:     'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
};

test('a desktop Chromium browser with both APIs can do everything', () => {
  for (const ua of [UA.chromeDesktop, UA.edgeDesktop, UA.operaDesktop]) {
    const c = classify({ ua, hasSerial: true, hasBle: true });
    assert.equal(c.level, 'full');
    assert.ok(c.canFlash && c.canSerial && c.canBle);
  }
});

test('Firefox and Safari on a desktop are named, and told which browsers work', () => {
  for (const ua of [UA.firefox, UA.safari]) {
    const c = classify({ ua, hasSerial: false, hasBle: false });
    assert.equal(c.level, 'none');
    assert.equal(c.canFlash, false);
    assert.equal(c.canSerial, false);
    assert.equal(c.canBle, false);
    assert.match(c.reason, /does not implement/);
    assert.match(c.advice, /Chrome, Edge or Opera/);
  }
});

test('every browser on iOS is refused, and is not told to install Chrome', () => {
  for (const ua of [UA.safariIos, UA.chromeIos]) {
    const c = classify({ ua, hasSerial: false, hasBle: false });
    assert.equal(c.os, 'ios');
    assert.equal(c.level, 'none');
    assert.match(c.advice, /desktop or laptop/);
    assert.doesNotMatch(c.advice, /Installing another browser here will help/);
  }
});

test('iPadOS masquerading as a Mac is still recognised as iOS', () => {
  const c = classify({
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    platform: 'MacIntel', maxTouchPoints: 5, hasSerial: false, hasBle: false,
  });
  assert.equal(c.os, 'ios');
  assert.equal(c.level, 'none');
});

test('Android Chrome can configure over Bluetooth but cannot flash', () => {
  const c = classify({ ua: UA.chromeAndroid, hasSerial: false, hasBle: true });
  assert.equal(c.level, 'ble-only');
  assert.equal(c.canBle, true);
  assert.equal(c.canFlash, false);
  assert.equal(c.canSerial, false);
  assert.match(c.reason, /Web Serial/);
});

test('an insecure page is refused for that reason, not blamed on the browser', () => {
  const c = classify({ ua: UA.chromeDesktop, hasSerial: false, hasBle: false, secure: false });
  assert.equal(c.level, 'none');
  assert.match(c.reason, /secure connection/);
  assert.match(c.advice, /https/);
});

test('Brave with Bluetooth switched off is told where the switch is', () => {
  const c = classify({ ua: UA.chromeDesktop, hasSerial: true, hasBle: false, brave: true });
  assert.equal(c.level, 'serial-only');
  assert.equal(c.browser, 'brave');
  assert.equal(c.canFlash, true);
  assert.equal(c.canBle, false);
  assert.match(c.advice, /Brave/);
});

test('a Chromium browser without Bluetooth still flashes', () => {
  const c = classify({ ua: UA.chromeDesktop, hasSerial: true, hasBle: false });
  assert.equal(c.level, 'serial-only');
  assert.equal(c.canFlash, true);
  assert.equal(c.canBle, false);
});

test('the secure-context check runs before the platform check', () => {
  const c = classify({ ua: UA.safariIos, hasSerial: false, hasBle: false, secure: false });
  assert.match(c.reason, /secure connection/);
});
