'use strict';
/**
 * DDX Transfer — the client half of the protocol, for the browser.
 *
 * The mirror of this exists in electron/src/db/transfer.js and in
 * flutter/lib/data/services/ddx_transfer_service.dart. The call ORDER matters
 * as much as the shapes: create -> chunks -> commit, and verify -> chunks ->
 * complete. A receiver never sees a byte of payload before it has passed
 * verify and a human has looked at the manifest.
 */
(function (global) {
  const C = global.DDXCrypto;

  class TransferError extends Error {
    constructor(code, extra) {
      super(code);
      this.code = code;
      Object.assign(this, extra || {});
    }
  }

  async function call(url, opts) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      // A dead network and a refusing server are different problems with
      // different fixes, so they get different codes all the way to the UI.
      throw new TransferError('network');
    }
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      const body = await res.json().catch(() => null);
      if (!body || body.ok === false) throw new TransferError(body?.code || 'server_error', body || {});
      return body;
    }
    if (!res.ok) throw new TransferError('server_error');
    return res;
  }

  const api = (base, path) => `${String(base).replace(/\/+$/, '')}${path}`;

  /**
   * Uploads a snapshot and returns everything the sender has to show:
   * the two codes, the QR/link, and the handle needed to poll or cancel.
   */
  async function send({ base, snapshot, name, allowTypedCode = true, source = 'web', onProgress }) {
    const key = C.newKey();
    const { data: body, compression } = await C.gzip(snapshot);

    const created = await call(api(base, '/api/create'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sizeBytes: body.length }),
    });

    // The framing adds an IV and a GCM tag per chunk, so the plaintext slice
    // has to be smaller than the server's limit by exactly that much or the
    // last chunk of a large vault gets rejected with too_large.
    const overhead = C.IV_BYTES + C.TAG_BYTES;
    const slices = C.splitChunks(body, created.maxChunkBytes - overhead);
    if (slices.length > created.maxChunks) throw new TransferError('too_large');

    for (let i = 0; i < slices.length; i++) {
      const framed = await C.sealChunk(key, slices[i]);
      await call(api(base, `/api/chunk/${created.transferId}/${i}`), {
        method: 'PUT',
        headers: { authorization: `Bearer ${created.uploadToken}`, 'content-type': 'application/octet-stream' },
        body: framed,
      });
      if (onProgress) onProgress((i + 1) / slices.length);
    }

    const manifest = {
      v: 1,
      name: String(name || 'Nexus'),
      sizeBytes: snapshot.length,
      compression,
      createdAt: Date.now(),
      source,
    };

    await call(api(base, '/api/commit'), {
      method: 'POST',
      headers: { authorization: `Bearer ${created.uploadToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        transferId: created.transferId,
        chunkCount: slices.length,
        sizeBytes: body.length,
        manifestEnc: await C.sealJson(key, manifest),
        // Omitting this is what "QR only" means on the wire: with no pinWrap
        // stored, the key exists nowhere but the fragment the sender shows.
        pinWrap: allowTypedCode ? await C.wrapKeyWithPin(key, created.code, created.pin) : null,
      }),
    });

    return {
      transferId: created.transferId,
      uploadToken: created.uploadToken,
      code: created.code,
      codeDisplay: created.codeDisplay,
      pin: created.pin,
      pinDisplay: created.pinDisplay,
      expiresAt: created.expiresAt,
      allowTypedCode,
      key,
      link: buildLink(base, created.code, key, created.pin),
    };
  }

  /**
   * The secrets go after the '#'. Everything there stays in the browser: it
   * is not sent in the request line and not in the Referer header, so a
   * scanned QR reveals the key to the scanning device and to nobody else.
   */
  function buildLink(base, code, key, pin) {
    const root = String(base).replace(/\/+$/, '');
    return `${root}/t/${code}#k=${C.toB64Url(key)}&p=${pin}`;
  }

  async function status({ base, transferId, uploadToken }) {
    return call(api(base, `/api/status/${transferId}`), {
      headers: { authorization: `Bearer ${uploadToken}` },
    });
  }

  async function cancel({ base, transferId, uploadToken }) {
    return call(api(base, `/api/cancel/${transferId}`), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${uploadToken}` },
    });
  }

  /**
   * Step one of receiving: prove you hold the code and PIN, get the sealed
   * manifest, open it locally. Returns the key alongside, because which of
   * the two ways of getting it worked is the caller's business, not the UI's.
   */
  async function verify({ base, code, pin, key = null }) {
    const res = await call(api(base, '/api/verify'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, pin }),
    });

    let transferKey = key;
    if (!transferKey) {
      // No key from a fragment and no pinWrap on the server means the sender
      // chose QR-only. Typing the code is simply not a way in for this one.
      if (!res.pinWrap) throw new TransferError('qr_only');
      try {
        transferKey = await C.unwrapKeyWithPin(res.pinWrap, code, pin);
      } catch (_) {
        throw new TransferError('bad_key');
      }
    }

    let manifest;
    try {
      manifest = await C.openJson(transferKey, res.manifestEnc);
    } catch (_) {
      // The server let us through, so the PIN was right — a manifest that
      // will not open means the key is wrong, i.e. a mangled fragment.
      throw new TransferError('bad_key');
    }

    return {
      transferId: res.transferId,
      receiptToken: res.receiptToken,
      chunkCount: res.chunkCount,
      sizeBytes: res.sizeBytes,
      expiresAt: res.expiresAt,
      key: transferKey,
      manifest,
    };
  }

  /** Step two: pull every chunk, decrypt, decompress, then tell the server to forget it. */
  async function receive({ base, transferId, receiptToken, key, chunkCount, manifest, onProgress }) {
    const parts = [];
    for (let i = 0; i < chunkCount; i++) {
      const res = await call(api(base, `/api/chunk/${transferId}/${i}`), {
        headers: { authorization: `Bearer ${receiptToken}` },
      });
      parts.push(await C.openChunk(key, await res.arrayBuffer()));
      if (onProgress) onProgress((i + 1) / chunkCount);
    }

    const snapshot = await C.gunzip(C.concatChunks(parts), manifest.compression);

    // Only now — the payload is in hand and it decrypted. Telling the server
    // to purge before this point would throw the vault away on a failed
    // gunzip with no way to retry.
    await call(api(base, '/api/complete'), {
      method: 'POST',
      headers: { authorization: `Bearer ${receiptToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ transferId }),
    }).catch(() => { /* the sweeper is the backstop; the user already has their data */ });

    return snapshot;
  }

  global.DDXApi = { send, verify, receive, status, cancel, buildLink, TransferError };
})(window);
