'use strict';
/**
 * midnight (dark, the app's default) <-> daylight (light), persisted. Loaded
 * synchronously in <head> so the stored choice lands before first paint —
 * without that the page flashes the wrong theme on every load. With nothing
 * stored the CSS follows the OS on its own and this sets no attribute at all.
 */
(function () {
  const KEY = 'ddx-trx-theme';
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) document.documentElement.setAttribute('data-theme', stored);
  } catch (_) {}

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const dark = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg').trim().toLowerCase() !== '#f4f6fb';
      const next = dark ? 'daylight' : 'midnight';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (_) {}
    });
  });
})();
