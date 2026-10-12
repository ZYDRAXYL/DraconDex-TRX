'use strict';
/**
 * /key/ — reads GET /api/sendkey with a viewer token (see
 * netlify/functions/sendkey.mts). The token is held in a local variable for
 * one request and the field is cleared; nothing is written to storage.
 */
(function (global) {
  const $ = (s) => document.querySelector(s);
  const t = (k, f) => (global.DDXLang ? global.DDXLang.t(k, f) : f);
  let current = '';

  const range = (from, until) => {
    const f = new Date(from), u = new Date(until);
    return `${f.toLocaleString()} → ${u.toLocaleString()}`;
  };

  function say(kind, text) {
    const n = $('#key-note');
    n.className = `note ${kind}`;
    n.textContent = text;
  }

  async function show() {
    const token = $('#key-token').value.trim();
    $('#key-token').value = '';
    if (!token) return;
    let res, body;
    try {
      res = await fetch('/api/sendkey', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
      body = await res.json();
    } catch (_) {
      say('warn', t('err_network', 'Could not reach the transfer service. Check your connection.'));
      return;
    }
    if (!body || !body.ok) {
      const code = body && body.code;
      say('warn', code === 'locked'
        ? t('key_err_locked', 'Too many wrong tokens from this connection. Wait 15 minutes.')
        : code === 'send_key_unavailable'
          ? t('key_err_off', 'This service has no send key configured — sending is not gated.')
          : t('key_err_token', 'That token is not valid, or it was revoked.'));
      return;
    }
    current = body.current.keyDisplay;
    $('#key-current').textContent = body.current.keyDisplay;
    $('#key-current-range').textContent = range(body.current.validFrom, body.current.validUntil);
    $('#key-next').textContent = body.next.keyDisplay;
    $('#key-next-range').textContent = range(body.next.validFrom, body.next.validUntil);
    $('#key-form').classList.add('hidden');
    $('#key-result').classList.remove('hidden');
  }

  function hide() {
    current = '';
    for (const id of ['#key-current', '#key-next', '#key-current-range', '#key-next-range']) $(id).textContent = '';
    $('#key-result').classList.add('hidden');
    $('#key-form').classList.remove('hidden');
  }

  $('#key-go').addEventListener('click', show);
  $('#key-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') show(); });
  $('#key-hide').addEventListener('click', hide);
  $('#key-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(current); say('ok', t('copied', 'Copied.')); } catch (_) {}
  });
  // Leaving the tab hides the keys — a shoulder-surfed screen is the likely leak.
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
})(window);
