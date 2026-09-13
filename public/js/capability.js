/**
 * What this browser can actually do with a radio, and what to tell someone
 * when the answer is "nothing".
 *
 * Feature detection alone is not enough here. `navigator.serial` being absent
 * is a fact, but it does not say whether the fix is "switch browser" or "use a
 * computer", and those are different instructions. Three cases in particular
 * are worth naming rather than lumping together:
 *
 *   iOS      every browser is Safari's engine underneath, so "install Chrome"
 *            is wrong advice: no browser on an iPhone can do this.
 *   Android  Chrome has Web Bluetooth but not Web Serial, so a Bluetooth
 *            companion can be configured while flashing is impossible.
 *   Brave    ships Web Bluetooth switched off, so the API can be missing on a
 *            Chromium browser that would otherwise work.
 *
 * classify() is pure so it can be tested against real user-agent strings.
 */

/** @returns {'full'|'serial-only'|'ble-only'|'none'} and why. */
export function classify({
  ua = '', hasSerial = false, hasBle = false, secure = true,
  brave = false, maxTouchPoints = 0, platform = '',
} = {}) {
  const browser = browserName(ua, brave);
  const os = osName(ua, platform, maxTouchPoints);

  // Both APIs need a secure context. Without one the flags below are all
  // false for a reason that has nothing to do with the browser.
  if (!secure) {
    return verdict('none', browser, os, {
      reason: 'This page is not being served over a secure connection.',
      advice: 'Browsers only hand out access to USB and Bluetooth devices over HTTPS. Open the site at its https:// address.',
    });
  }

  if (os === 'ios') {
    return verdict('none', browser, os, {
      reason: 'Every browser on iPhone and iPad is built on Safari’s engine, which cannot reach a USB or Bluetooth device from a web page.',
      advice: 'Installing another browser here will not help. Use a desktop or laptop running Chrome, Edge or Opera.',
    });
  }

  if (hasSerial && hasBle) return verdict('full', browser, os, {});

  if (hasSerial && !hasBle) {
    return verdict('serial-only', browser, os, {
      reason: 'This browser can reach a radio over USB but not over Bluetooth.',
      advice: brave
        ? 'Brave ships with Web Bluetooth switched off. Turn it on in Settings under Privacy and security, or use Chrome for a Bluetooth radio.'
        : 'Flashing and USB radios work normally. For a Bluetooth companion, use Chrome, Edge or Opera with Bluetooth turned on.',
    });
  }

  if (!hasSerial && hasBle) {
    return verdict('ble-only', browser, os, {
      reason: os === 'android'
        ? 'Android browsers have Bluetooth but no Web Serial, which is what writing firmware needs.'
        : 'This browser has Bluetooth but not Web Serial, which is what writing firmware needs.',
      advice: 'You can configure a Bluetooth companion from here. Flashing, and any radio on a cable, needs Chrome, Edge or Opera on a computer.',
    });
  }

  return verdict('none', browser, os, {
    reason: browser === 'firefox' || browser === 'safari'
      ? `${titleCase(browser)} does not implement Web Serial or Web Bluetooth, so it cannot reach a radio at all.`
      : 'This browser cannot reach a radio over USB or Bluetooth.',
    advice: os === 'android'
      ? 'Use Chrome on this phone for a Bluetooth radio, or a computer running Chrome, Edge or Opera to flash one.'
      : 'Chrome, Edge or Opera on a desktop can do it. Everything up to connecting works here, so you can still check what would be written.',
  });
}

function verdict(level, browser, os, { reason = '', advice = '' }) {
  return {
    level, browser, os, reason, advice,
    canFlash: level === 'full' || level === 'serial-only',
    canSerial: level === 'full' || level === 'serial-only',
    canBle: level === 'full' || level === 'ble-only',
  };
}

function browserName(ua, brave) {
  if (brave) return 'brave';
  if (/\bEdg[A-Z]?\//.test(ua)) return 'edge';
  if (/\bOPR\/|\bOpera[\s/]/.test(ua)) return 'opera';
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'firefox';
  if (/\bCriOS\//.test(ua)) return 'chrome';
  if (/\bChrome\//.test(ua)) return 'chrome';
  if (/\bSafari\//.test(ua)) return 'safari';
  return 'other';
}

function osName(ua, platform, maxTouchPoints) {
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return 'ios';
  // iPadOS reports itself as a Mac; a Mac with a touchscreen is the tell.
  if (platform === 'MacIntel' && maxTouchPoints > 1) return 'ios';
  if (/\bAndroid\b/.test(ua)) return 'android';
  return 'desktop';
}

function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/** Reads the real environment. Async only because Brave answers async. */
export async function detect(nav = globalThis.navigator, win = globalThis) {
  let brave = false;
  try {
    brave = Boolean(nav?.brave && await nav.brave.isBrave());
  } catch { /* not Brave, or it declined to say */ }

  return classify({
    ua: nav?.userAgent ?? '',
    // The object existing is not the same as the call being there.
    hasSerial: typeof nav?.serial?.requestPort === 'function',
    hasBle: typeof nav?.bluetooth?.requestDevice === 'function',
    secure: win?.isSecureContext !== false,
    brave,
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    platform: nav?.platform ?? '',
  });
}
