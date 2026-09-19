'use strict';

// @xterm/headless reads `navigator.userAgent` and `navigator.platform` while it loads,
// to tell Firefox and Safari from the rest. Hermes defines `navigator` with only
// `product: 'ReactNative'`, so the first require of xterm threw "Cannot read property
// 'includes' of undefined" before the app rendered (Pixel 9a, 2026-09-19). This runs
// before anything requires xterm and gives both fields a string. Node has both, so
// under `node --test` it changes nothing.

function polyfillNavigator(nav) {
  if (!nav || typeof nav !== 'object') return [];
  const added = [];
  for (const key of ['userAgent', 'platform']) {
    if (typeof nav[key] === 'string') continue;
    try {
      Object.defineProperty(nav, key, { value: 'ReactNative', configurable: true, writable: true });
      added.push(key);
    } catch {}
  }
  return added;
}

polyfillNavigator(typeof navigator !== 'undefined' ? navigator : null);

module.exports = { polyfillNavigator };
