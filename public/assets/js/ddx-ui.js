'use strict';
/**
 * DDX Transfer — the page behaviour shared by / and /t/:code.
 *
 * Everything sensitive happens here, in the tab: the key is generated here,
 * the payload is sealed here, and a received vault is opened here. The
 * functions in ddx-api.js never hand the server anything it could read.
 */
(function (global) {
  const { DDXCrypto: C, DDXApi: Api } = global;
  const BASE = location.origin;

  const $ = (sel, root = document) => root.querySelector(sel);
  const t = (key, fallback) => (global.DDXLang ? global.DDXLang.t(key, fallback) : fallback);

  /** Error code -> what a person should read. Never the raw code. */
  function message(err) {
    const code = err && err.code ? err.code : 'server_error';
    const extra = code === 'locked' && err.retryAfterMs
      ? ` (${Math.ceil(err.retryAfterMs / 60000)} min)`
      : '';
    const map = {
      network: 'Could not reach the transfer service. Check your connection.',
      bad_code: 'That transfer code or PIN is not right.',
      locked: 'Too many wrong PINs. This transfer is locked for a while.',
      expired: 'This transfer has expired. Ask the sender to start a new one.',
      gone: 'This transfer no longer exists — it was received or cancelled.',
      not_ready: 'The sender has not finished uploading yet. Try again in a moment.',
      too_large: 'That Nexus is larger than a single transfer allows.',
      bad_token: 'This session is no longer valid. Start again.',
      bad_request: 'Something about that request was malformed.',
      qr_only: 'The sender allowed the QR code only. Scan it instead of typing.',
      bad_key: 'That link is incomplete — the key part is missing or damaged.',
      gzip_unsupported: 'This browser cannot decompress the payload. Try a newer one.',
      server_error: 'The transfer service had a problem.',
    };
    return t(`err_${code}`, map[code] || map.server_error) + extra;
  }

  function notice(el, kind, text) {
    if (!el) return;
    el.className = `note ${kind}`;
    el.textContent = text;
    el.classList.remove('hidden');
  }
  const clearNotice = (el) => el && el.classList.add('hidden');

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  const formatTime = (ms) => new Date(ms).toLocaleString();

  /** Draws the QR as inline SVG — no canvas, no raster, scales to any screen. */
  function renderQr(host, text) {
    const qr = global.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4; // the spec's quiet zone; without it many scanners refuse
    const size = n + quiet * 2;
    let path = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    host.innerHTML =
      `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${t('qr_alt', 'Transfer QR code')}">`
      + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }

  /* ---- input shaping ---------------------------------------------------- */

  /** ABCD-EFGH as you type, and paste-friendly: any junk in between is dropped. */
  function bindCodeInput(input) {
    input.addEventListener('input', () => {
      const raw = input.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
      input.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
    });
  }

  function bindPinInput(input) {
    input.addEventListener('input', () => {
      const raw = input.value.replace(/[^0-9]/g, '').slice(0, 6);
      input.value = raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
    });
  }

  /* ---- send ------------------------------------------------------------- */

  function mountSend(root) {
    const file = $('#send-file', root);
    const name = $('#send-name', root);
    const typed = $('#send-typed', root);
    const go = $('#send-go', root);
    const bar = $('#send-progress', root);
    const note = $('#send-note', root);
    const form = $('#send-form', root);
    const result = $('#send-result', root);
    let sent = null;
    let poll = null;

    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      // Pre-fill the project name from the filename, but leave it editable —
      // this is the one string the receiver sees before importing.
      if (f && !name.value) name.value = f.name.replace(/\.(ddx|json|mdx|db)$/i, '');
      go.disabled = !f;
    });

    go.addEventListener('click', async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      go.disabled = true;
      clearNotice(note);
      bar.classList.remove('hidden');
      bar.value = 0;

      try {
        const snapshot = new Uint8Array(await f.arrayBuffer());
        // Fail here rather than after a full upload that the receiver then
        // cannot import.
        try { JSON.parse(new TextDecoder().decode(snapshot)); }
        catch { throw new Api.TransferError('not_a_snapshot'); }

        sent = await Api.send({
          base: BASE,
          snapshot,
          name: name.value || f.name,
          allowTypedCode: typed.checked,
          source: 'web',
          onProgress: (p) => { bar.value = p; },
        });

        form.classList.add('hidden');
        result.classList.remove('hidden');
        $('#send-code', root).textContent = sent.codeDisplay;
        $('#send-pin-row', root).classList.toggle('hidden', !sent.allowTypedCode);
        $('#send-pin', root).textContent = sent.pinDisplay;
        renderQr($('#send-qr', root), sent.link);
        $('#send-mode', root).textContent = sent.allowTypedCode
          ? t('send_mode_typed', 'Scan the QR, or type the code and PIN. While this transfer is waiting, the service holds a copy of the key sealed under the PIN.')
          : t('send_mode_qr', 'QR or link only. The key never reaches the service, so nobody but the scanning device can open this.');

        poll = setInterval(async () => {
          try {
            const s = await Api.status({ base: BASE, transferId: sent.transferId, uploadToken: sent.uploadToken });
            if (s.status === 'gone' || s.status === 'expired') {
              clearInterval(poll);
              notice($('#send-status', root), s.status === 'expired' ? 'warn' : 'ok',
                s.status === 'expired'
                  ? t('send_expired', 'This transfer expired before it was received.')
                  : t('send_done', 'Received. The copy on the service has been deleted.'));
            } else if (s.claimed) {
              notice($('#send-status', root), 'ok', t('send_claimed', 'The receiver has verified the code and is downloading…'));
            }
          } catch (_) { /* a dropped poll is not worth interrupting the user over */ }
        }, 4000);
      } catch (e) {
        bar.classList.add('hidden');
        go.disabled = false;
        notice(note, 'error', e.code === 'not_a_snapshot'
          ? t('err_not_a_snapshot', 'That does not look like a DraconDex export. Use the file from Settings → App data → Database.')
          : message(e));
      }
    });

    $('#send-copy', root).addEventListener('click', async () => {
      if (!sent) return;
      await navigator.clipboard.writeText(sent.link);
      notice($('#send-status', root), 'ok', t('copied', 'Link copied.'));
    });

    $('#send-cancel', root).addEventListener('click', async () => {
      if (!sent) return;
      clearInterval(poll);
      try { await Api.cancel({ base: BASE, transferId: sent.transferId, uploadToken: sent.uploadToken }); } catch (_) {}
      location.reload();
    });
  }

  /* ---- receive ---------------------------------------------------------- */

  /**
   * `prefill` carries what a scanned QR put in the fragment. The key arrives
   * as raw bytes and stays in this closure — it is never written to the DOM,
   * to storage, or to any request body.
   */
  function mountReceive(root, prefill) {
    const codeEl = $('#recv-code', root);
    const pinEl = $('#recv-pin', root);
    const verify = $('#recv-verify', root);
    const note = $('#recv-note', root);
    const form = $('#recv-form', root);
    const card = $('#recv-card', root);
    const bar = $('#recv-progress', root);
    let session = null;
    let fragmentKey = prefill && prefill.key ? prefill.key : null;

    bindCodeInput(codeEl);
    bindPinInput(pinEl);

    if (prefill && prefill.code) codeEl.value = prefill.code.length > 4
      ? `${prefill.code.slice(0, 4)}-${prefill.code.slice(4)}` : prefill.code;
    if (prefill && prefill.pin) pinEl.value = prefill.pin.length > 3
      ? `${prefill.pin.slice(0, 3)}-${prefill.pin.slice(3)}` : prefill.pin;

    verify.addEventListener('click', async () => {
      clearNotice(note);
      verify.disabled = true;
      try {
        session = await Api.verify({
          base: BASE,
          code: codeEl.value,
          pin: pinEl.value,
          key: fragmentKey,
        });

        // The two-step: what is in the transfer is shown FIRST, and nothing
        // is downloaded until a person has looked at it and pressed Receive.
        form.classList.add('hidden');
        card.classList.remove('hidden');
        $('#recv-name', root).textContent = session.manifest.name;
        $('#recv-size', root).textContent = formatBytes(session.manifest.sizeBytes);
        $('#recv-created', root).textContent = formatTime(session.manifest.createdAt);
        $('#recv-source', root).textContent = session.manifest.source || '—';
      } catch (e) {
        notice(note, 'error', message(e));
      } finally {
        verify.disabled = false;
      }
    });

    $('#recv-go', root).addEventListener('click', async () => {
      if (!session) return;
      const go = $('#recv-go', root);
      go.disabled = true;
      bar.classList.remove('hidden');
      bar.value = 0;
      try {
        const snapshot = await Api.receive({
          base: BASE,
          transferId: session.transferId,
          receiptToken: session.receiptToken,
          key: session.key,
          chunkCount: session.chunkCount,
          manifest: session.manifest,
          onProgress: (p) => { bar.value = p; },
        });

        const safeName = (session.manifest.name || 'nexus').replace(/[^\w฀-๿.-]+/g, '-');
        const url = URL.createObjectURL(new Blob([snapshot], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${safeName}.ddx`;
        a.click();
        URL.revokeObjectURL(url);

        bar.classList.add('hidden');
        notice($('#recv-status', root), 'ok',
          t('recv_done', 'Downloaded. Import it with Settings → App data → Database → Import Nexus.'));
      } catch (e) {
        bar.classList.add('hidden');
        go.disabled = false;
        notice($('#recv-status', root), 'error', message(e));
      }
    });
  }

  /**
   * Pulls the code from the path and the secrets from the fragment. The
   * fragment is cleared from the address bar immediately afterwards: it is
   * the whole key, and leaving it there puts a decryptable vault into the
   * browser history and into whatever the next screenshot catches.
   */
  function readLanding() {
    const code = (location.pathname.split('/').filter(Boolean).pop() || '')
      .toUpperCase().replace(/[^0-9A-Z]/g, '');
    const frag = new URLSearchParams(location.hash.replace(/^#/, ''));
    const k = frag.get('k');
    const p = frag.get('p');
    let key = null;
    try { if (k) key = C.fromB64(k); } catch (_) { key = null; }
    if (key && key.length !== C.KEY_BYTES) key = null;

    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    return { code, pin: p || '', key };
  }

  global.DDXUi = { mountSend, mountReceive, readLanding, message, notice, renderQr, formatBytes };
})(window);
