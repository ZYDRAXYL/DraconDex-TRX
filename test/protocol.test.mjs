import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The whole protocol, driven through the real function handlers with the blob
 * store swapped for an in-memory one.
 *
 * This is the level the interesting bugs live at: an upload that commits
 * without its chunks, a PIN lockout that never arms, a receipt token that can
 * write, a purge that leaves the payload behind. None of those are visible
 * from a unit test of any single file, and all of them are expensive to find
 * by hand with two devices.
 */

/* ---- an in-memory Netlify Blobs store --------------------------------- */
function makeStore() {
  const data = new Map();
  return {
    _data: data,
    async get(key, opts) {
      if (!data.has(key)) return null;
      const v = data.get(key);
      if (opts?.type === 'json') return JSON.parse(new TextDecoder().decode(v));
      if (opts?.type === 'arrayBuffer') return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
      return new TextDecoder().decode(v);
    },
    async getMetadata(key) { return data.has(key) ? { etag: 'x', metadata: {} } : null; },
    async set(key, value) {
      data.set(key, value instanceof Uint8Array ? value : new TextEncoder().encode(String(value)));
    },
    async setJSON(key, value) { data.set(key, new TextEncoder().encode(JSON.stringify(value))); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) {
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: 'x' })) };
    },
  };
}

let store = makeStore();
mock.module('@netlify/blobs', {
  namedExports: { getStore: () => store, getDeployStore: () => store },
});

const { default: create }   = await import('../netlify/functions/create.mts');
const { default: chunk }    = await import('../netlify/functions/chunk.mts');
const { default: commit }   = await import('../netlify/functions/commit.mts');
const { default: verify }   = await import('../netlify/functions/verify.mts');
const { default: session }  = await import('../netlify/functions/session.mts');
const { default: complete } = await import('../netlify/functions/complete.mts');
const { default: sweep }    = await import('../netlify/functions/sweep.mts');

/* ---- request helpers --------------------------------------------------- */
const ORIGIN = 'https://transfer.example';
const req = (path, init = {}) => new Request(`${ORIGIN}${path}`, init);
const bearerInit = (token, extra = {}) => ({
  ...extra,
  headers: { authorization: `Bearer ${token}`, ...(extra.headers || {}) },
});
const jsonInit = (body, token) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const body = async (res) => res.json();

/** Stands in for the sealed blobs — these handlers never look inside them. */
const sealedStub = { iv: 'AAAAAAAAAAAAAAAA', ct: 'Y2lwaGVydGV4dA==' };
const pinWrapStub = { ...sealedStub, salt: 'c2FsdA==', iters: 600000 };

async function newTransfer() {
  const res = await create(req('/api/create', jsonInit({ sizeBytes: 1024 })));
  return body(res);
}

async function uploadAndCommit(t, chunks = ['one', 'two'], opts = {}) {
  for (let i = 0; i < chunks.length; i++) {
    const r = await chunk(
      req(`/api/chunk/${t.transferId}/${i}`, bearerInit(t.uploadToken, {
        method: 'PUT', body: new TextEncoder().encode(chunks[i]),
      })),
      { params: { id: t.transferId, n: String(i) } },
    );
    assert.equal((await body(r)).ok, true, `chunk ${i} upload`);
  }
  return commit(req('/api/commit', jsonInit({
    transferId: t.transferId,
    chunkCount: chunks.length,
    sizeBytes: 1024,
    manifestEnc: sealedStub,
    pinWrap: opts.pinWrap === undefined ? pinWrapStub : opts.pinWrap,
  }, t.uploadToken)));
}

test.beforeEach(() => { store = makeStore(); });

/* ---- the happy path ---------------------------------------------------- */

test('a transfer goes create -> chunks -> commit -> verify -> chunks -> complete', async () => {
  const t = await newTransfer();
  assert.match(t.code, /^[0-9A-Z]{8}$/);
  assert.match(t.pin, /^[0-9]{6}$/);
  assert.equal(t.codeDisplay, `${t.code.slice(0, 4)}-${t.code.slice(4)}`);
  assert.ok(t.maxChunkBytes > 0 && t.maxChunkBytes < 6 * 1024 * 1024);

  assert.equal((await body(await uploadAndCommit(t))).status, 'waiting');

  const v = await body(await verify(req('/api/verify', jsonInit({ code: t.code, pin: t.pin }))));
  assert.equal(v.ok, true);
  assert.equal(v.chunkCount, 2);
  assert.deepEqual(v.manifestEnc, sealedStub);
  assert.ok(v.receiptToken);

  const c0 = await chunk(req(`/api/chunk/${t.transferId}/0`, bearerInit(v.receiptToken)),
    { params: { id: t.transferId, n: '0' } });
  assert.equal(new TextDecoder().decode(await c0.arrayBuffer()), 'one');

  assert.equal((await body(await complete(req('/api/complete', jsonInit({ transferId: t.transferId }, v.receiptToken))))).ok, true);

  // Nothing of this transfer may survive being received — payload, metadata
  // or code index. This assertion is the promise the whole service makes.
  assert.equal(store._data.size, 0, `leftover keys: ${[...store._data.keys()].join(', ')}`);
});

test('the code is accepted in the shape a human types it', async () => {
  const t = await newTransfer();
  await uploadAndCommit(t);
  const typed = `${t.code.slice(0, 4)}-${t.code.slice(4)}`.toLowerCase();
  const pinTyped = `${t.pin.slice(0, 3)}-${t.pin.slice(3)}`;
  assert.equal((await body(await verify(req('/api/verify', jsonInit({ code: typed, pin: pinTyped }))))).ok, true);
});

/* ---- refusals ---------------------------------------------------------- */

test('a wrong PIN fails, and five of them lock the transfer', async () => {
  const t = await newTransfer();
  await uploadAndCommit(t);
  const wrong = t.pin === '000000' ? '111111' : '000000';

  for (let i = 1; i <= 4; i++) {
    const r = await body(await verify(req('/api/verify', jsonInit({ code: t.code, pin: wrong }))));
    assert.equal(r.code, 'bad_code', `attempt ${i}`);
    assert.equal(r.attemptsLeft, 5 - i);
  }
  assert.equal((await body(await verify(req('/api/verify', jsonInit({ code: t.code, pin: wrong }))))).code, 'locked');

  // Locked means locked even for the right PIN — otherwise the lock protects
  // nothing an attacker cares about.
  assert.equal((await body(await verify(req('/api/verify', jsonInit({ code: t.code, pin: t.pin }))))).code, 'locked');
});

test('an unknown code is refused with the same code as a wrong PIN', async () => {
  const t = await newTransfer();
  await uploadAndCommit(t);
  const unknown = await body(await verify(req('/api/verify', jsonInit({ code: 'ZZZZZZZZ', pin: '123456' }))));
  const wrongPin = await body(await verify(req('/api/verify', jsonInit({
    code: t.code, pin: t.pin === '000000' ? '111111' : '000000',
  }))));
  // Distinguishing them would make the code space enumerable without ever
  // knowing a PIN.
  assert.equal(unknown.code, 'bad_code');
  assert.equal(wrongPin.code, 'bad_code');
});

test('verify refuses a transfer that has not committed yet', async () => {
  const t = await newTransfer();
  assert.equal((await body(await verify(req('/api/verify', jsonInit({ code: t.code, pin: t.pin }))))).code, 'not_ready');
});

test('commit refuses when a chunk it claims is missing', async () => {
  const t = await newTransfer();
  await chunk(req(`/api/chunk/${t.transferId}/0`, bearerInit(t.uploadToken, { method: 'PUT', body: new TextEncoder().encode('one') })),
    { params: { id: t.transferId, n: '0' } });
  // Says three, uploaded one.
  const r = await body(await commit(req('/api/commit', jsonInit({
    transferId: t.transferId, chunkCount: 3, sizeBytes: 10, manifestEnc: sealedStub, pinWrap: pinWrapStub,
  }, t.uploadToken))));
  assert.equal(r.code, 'not_ready');
  assert.equal(r.missing, true);
});

test('an upload token cannot read and a receipt token cannot write', async () => {
  const t = await newTransfer();
  await uploadAndCommit(t);
  const v = await body(await verify(req('/api/verify', jsonInit({ code: t.code, pin: t.pin }))));

  const readWithUpload = await chunk(req(`/api/chunk/${t.transferId}/0`, bearerInit(t.uploadToken)),
    { params: { id: t.transferId, n: '0' } });
  assert.equal((await body(readWithUpload)).code, 'bad_token');

  const writeWithReceipt = await chunk(
    req(`/api/chunk/${t.transferId}/0`, bearerInit(v.receiptToken, { method: 'PUT', body: new TextEncoder().encode('evil') })),
    { params: { id: t.transferId, n: '0' } },
  );
  assert.equal((await body(writeWithReceipt)).code, 'bad_token');
});

test('chunks cannot be rewritten once the transfer is committed', async () => {
  const t = await newTransfer();
  await uploadAndCommit(t);
  const r = await chunk(
    req(`/api/chunk/${t.transferId}/0`, bearerInit(t.uploadToken, { method: 'PUT', body: new TextEncoder().encode('swapped') })),
    { params: { id: t.transferId, n: '0' } },
  );
  // Otherwise the sender could swap the payload out from under a receiver
  // who has already read the manifest and pressed Receive.
  assert.equal((await body(r)).code, 'not_ready');
});

test('commit rejects a malformed manifest or pinWrap', async () => {
  const t = await newTransfer();
  await chunk(req(`/api/chunk/${t.transferId}/0`, bearerInit(t.uploadToken, { method: 'PUT', body: new TextEncoder().encode('x') })),
    { params: { id: t.transferId, n: '0' } });

  const bad = async (patch) => (await body(await commit(req('/api/commit', jsonInit({
    transferId: t.transferId, chunkCount: 1, sizeBytes: 10, manifestEnc: sealedStub, pinWrap: pinWrapStub, ...patch,
  }, t.uploadToken))))).code;

  assert.equal(await bad({ manifestEnc: null }), 'bad_request');
  assert.equal(await bad({ manifestEnc: { iv: 'a' } }), 'bad_request');
  assert.equal(await bad({ pinWrap: { ...pinWrapStub, iters: 10 } }), 'bad_request', 'a weak KDF must not be accepted');
});

/* ---- the QR-only mode -------------------------------------------------- */

test('QR-only mode stores no key for the server to hold', async () => {
  const t = await newTransfer();
  await uploadAndCommit(t, ['one'], { pinWrap: null });
  const v = await body(await verify(req('/api/verify', jsonInit({ code: t.code, pin: t.pin }))));
  assert.equal(v.ok, true);
  // The code and PIN still authenticate — they just do not unlock anything.
  // A typed-code client gets null here and stops.
  assert.equal(v.pinWrap, null);
});

/* ---- the sender's own controls ---------------------------------------- */

test('the sender can see when a receiver has claimed the transfer', async () => {
  const t = await newTransfer();
  await uploadAndCommit(t);

  const before = await body(await session(req(`/api/status/${t.transferId}`, bearerInit(t.uploadToken)),
    { params: { id: t.transferId } }));
  assert.equal(before.status, 'waiting');
  assert.equal(before.claimed, false);

  await verify(req('/api/verify', jsonInit({ code: t.code, pin: t.pin })));

  const after = await body(await session(req(`/api/status/${t.transferId}`, bearerInit(t.uploadToken)),
    { params: { id: t.transferId } }));
  assert.equal(after.claimed, true);
});

test('cancel removes everything, including chunks', async () => {
  const t = await newTransfer();
  await uploadAndCommit(t);
  await session(req(`/api/cancel/${t.transferId}`, bearerInit(t.uploadToken, { method: 'DELETE' })),
    { params: { id: t.transferId } });
  assert.equal(store._data.size, 0);
});

/* ---- expiry ------------------------------------------------------------ */

test('an expired transfer is refused and purged on the next read', async () => {
  const t = await newTransfer();
  await uploadAndCommit(t);

  const metaKey = `t/${t.transferId}/meta`;
  const meta = JSON.parse(new TextDecoder().decode(store._data.get(metaKey)));
  meta.expiresAt = Date.now() - 1;
  await store.setJSON(metaKey, meta);

  assert.equal((await body(await verify(req('/api/verify', jsonInit({ code: t.code, pin: t.pin }))))).code, 'expired');
  assert.equal(store._data.size, 0);
});

test('the sweeper reaches transfers nobody ever came back for', async () => {
  const live = await newTransfer();
  await uploadAndCommit(live);

  const dead = await newTransfer();
  await uploadAndCommit(dead);
  const deadKey = `t/${dead.transferId}/meta`;
  const meta = JSON.parse(new TextDecoder().decode(store._data.get(deadKey)));
  meta.expiresAt = Date.now() - 1;
  await store.setJSON(deadKey, meta);

  await sweep();

  assert.equal(store._data.has(deadKey), false, 'the expired transfer should be gone');
  assert.equal(store._data.has(`t/${dead.transferId}/c/0`), false, 'its chunks too');
  assert.equal(store._data.has(`t/${live.transferId}/meta`), true, 'the live one must be untouched');
});

test('the sweeper cleans up an upload that never committed', async () => {
  // chunkCount is still 0 on an uncommitted transfer. Purging by counting
  // would walk none of its chunks and leak the payload past its own expiry —
  // so purge lists the prefix instead.
  const t = await newTransfer();
  await chunk(req(`/api/chunk/${t.transferId}/0`, bearerInit(t.uploadToken, { method: 'PUT', body: new TextEncoder().encode('orphan') })),
    { params: { id: t.transferId, n: '0' } });

  const metaKey = `t/${t.transferId}/meta`;
  const meta = JSON.parse(new TextDecoder().decode(store._data.get(metaKey)));
  meta.expiresAt = Date.now() - 1;
  await store.setJSON(metaKey, meta);

  await sweep();
  assert.equal(store._data.size, 0, `leftover keys: ${[...store._data.keys()].join(', ')}`);
});

/* ---- CORS -------------------------------------------------------------- */

test('CORS lets the PWA origin in and keeps strangers out', async () => {
  const allowed = await create(req('/api/create', {
    ...jsonInit({ sizeBytes: 1 }), headers: { 'content-type': 'application/json', origin: 'https://zydraxyl.github.io' },
  }));
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://zydraxyl.github.io');

  const stranger = await create(req('/api/create', {
    ...jsonInit({ sizeBytes: 1 }), headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  }));
  assert.equal(stranger.headers.get('access-control-allow-origin'), null);
});

test('an oversized transfer is refused before a byte is uploaded', async () => {
  const r = await body(await create(req('/api/create', jsonInit({ sizeBytes: 500 * 1024 * 1024 }))));
  assert.equal(r.code, 'too_large');
});
