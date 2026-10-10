'use strict';
/**
 * TH/EN switch, the same shape the website uses (DraconDex-WEB
 * assets/js/lang.js): English lives in the HTML so nothing has to be listed
 * for it, and every element tagged data-i18n="key" is swapped against the
 * Thai dictionary. Attributes go through data-i18n-attr="attr:key".
 *
 * Runtime strings (error messages, the manifest card) come through
 * DDXLang.t(key, englishFallback) instead, for the same reason.
 */
(function (global) {
  const KEY = 'ddx-trx-lang';
  // Browser preference first, an explicit stored choice over the top of it.
  let lang = (navigator.language || '').toLowerCase().startsWith('th') ? 'th' : 'en';
  try { lang = localStorage.getItem(KEY) || lang; } catch (_) {}

  const dict = () => (lang === 'th' && global.DDX_TH) || {};

  function t(key, fallback) {
    const v = dict()[key];
    return typeof v === 'string' ? v : fallback;
  }

  function apply() {
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const key = el.getAttribute('data-i18n');
      if (!el.dataset.i18nEn) el.dataset.i18nEn = el.textContent;
      el.textContent = t(key, el.dataset.i18nEn);
    }
    for (const el of document.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.getAttribute('data-i18n-attr').split(',')) {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (!attr || !key) continue;
        // dataset keys must be valid camelCase names — `i18nAttr_aria-label`
        // threw and stopped every translation after it on the page.
        const memo = `i18nAttr${attr.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase())}`;
        if (!el.dataset[memo]) el.dataset[memo] = el.getAttribute(attr) || '';
        el.setAttribute(attr, t(key, el.dataset[memo]));
      }
    }
    const btn = document.getElementById('lang-toggle');
    if (btn) btn.textContent = lang === 'th' ? 'EN' : 'TH';
  }

  function toggle() {
    lang = lang === 'th' ? 'en' : 'th';
    try { localStorage.setItem(KEY, lang); } catch (_) {}
    apply();
  }

  global.DDXLang = { t, apply, toggle, get current() { return lang; } };
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    const btn = document.getElementById('lang-toggle');
    if (btn) btn.addEventListener('click', toggle);
  });
})(window);
