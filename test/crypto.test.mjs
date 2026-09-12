import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * public/assets/js/ddx-crypto.js is a browser script, but every primitive in
 * it is WebCrypto, which Node has had since 18 — so it can be loaded into a
 * sandbox and held to the wire contract here, in CI, instead of only ever
 * being exercised by a human with two devices.
 *
 * What this guards is the thing that breaks silently: the browser, Electron
 * and Flutter implementations all have to produce the same bytes, and a
 * mismatch shows up not as an exception but as a vault that imports as
 * nonsense.
 */
function loadCrypto() {
  const sandbox = {
    window: {}, crypto: globalThis.crypto, TextEncoder, TextDecoder,
    btoa, atob, Blob, CompressionStream, DecompressionStream, console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../public/assets/js/ddx-crypto.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.window.DDXCrypto;
}

const C = loadCrypto();

const sampleSnapshot = () => new TextEncoder().encode(JSON.stringify({
  format: 'dracondex-vault-snapshot',
  version: 1,
  nexus: { name: 'My World' },
  modules: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Module ${i}`, kind: 'classifier' })),
}));

test('the wire parameters are the ones all three clients agree on', () => {
  assert.equal(C.KEY_BYTES, 32);
  assert.equal(C.IV_BYTES, 12);
  assert.equal(C.TAG_BYTES, 16);
  assert.equal(C.PBKDF2_ITERS, 600000);
});

test('a snapshot survives gzip, chunking, encryption and the whole way back', async () => {
  const snapshot = sampleSnapshot();
  const key = C.newKey();
  const { data: body, compression } = await C.gzip(snapshot);

  const slices = C.splitChunks(body, 512 - C.IV_BYTES - C.TAG_BYTES);
  assert.ok(slices.length > 1, 'the test payload must actually span several chunks');

  const framed = [];
  for (const s of slices) framed.push(await C.sealChunk(key, s));

  // The reason splitChunks subtracts the framing: a chunk that lands one byte
  // over the server limit is rejected, and it would only ever be the last
  // chunk of a large vault, i.e. only in the case nobody tests by hand.
  for (const f of framed) assert.ok(f.length <= 512, `framed chunk ${f.length} exceeds the limit`);

  const back = [];
  for (const f of framed) back.push(await C.openChunk(key, f));
  const rebuilt = await C.gunzip(C.concatChunks(back), compression);
  assert.deepEqual(Buffer.from(rebuilt), Buffer.from(snapshot));
});

test('gzip earns its place on a real snapshot', async () => {
  const snapshot = sampleSnapshot();
  const { data, compression } = await C.gzip(snapshot);
  assert.equal(compression, 'gzip');
  assert.ok(data.length < snapshot.length / 4);
});

test('an uncompressed payload round-trips too (older Safari has no CompressionStream)', async () => {
  const snapshot = sampleSnapshot();
  const key = C.newKey();
  const framed = await C.sealChunk(key, snapshot);
  const out = await C.gunzip(await C.openChunk(key, framed), 'none');
  assert.deepEqual(Buffer.from(out), Buffer.from(snapshot));
});

test('the manifest round-trips under the transfer key', async () => {
  const key = C.newKey();
  const manifest = { v: 1, name: 'โลกของฉัน', sizeBytes: 2411, compression: 'gzip', createdAt: 1700000000000 };
  const back = await C.openJson(key, await C.sealJson(key, manifest));
  // Compared as JSON, not deepEqual: the object comes back from the vm
  // sandbox's realm, so its prototype is a different Object than this
  // realm's and deepEqual calls that a mismatch. The bytes are what matter.
  assert.equal(JSON.stringify(back), JSON.stringify(manifest));
  assert.equal(back.name, 'โลกของฉัน', 'non-ASCII names must survive the round trip');
});

test('pinWrap round-trips, and only with the right PIN', async () => {
  const key = C.newKey();
  const wrap = await C.wrapKeyWithPin(key, 'ABCD1234', '482719');

  assert.deepEqual(Buffer.from(await C.unwrapKeyWithPin(wrap, 'ABCD1234', '482719')), Buffer.from(key));
  await assert.rejects(() => C.unwrapKeyWithPin(wrap, 'ABCD1234', '000000'));
  // Binding the code in as well means a pinWrap lifted from one transfer is
  // useless against another that happens to share a PIN.
  await assert.rejects(() => C.unwrapKeyWithPin(wrap, 'ZZZZ9999', '482719'));

  // commit.mts rejects anything outside this band.
  assert.ok(wrap.iters >= 100000 && wrap.iters <= 2000000);
});

test('a tampered chunk fails the GCM tag rather than decrypting to garbage', async () => {
  const key = C.newKey();
  const framed = await C.sealChunk(key, new TextEncoder().encode('a vault'));
  const tampered = Uint8Array.from(framed);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(() => C.openChunk(key, tampered));
});

test('the wrong key fails the same way', async () => {
  const framed = await C.sealChunk(C.newKey(), new TextEncoder().encode('a vault'));
  await assert.rejects(() => C.openChunk(C.newKey(), framed));
});

test('an empty payload still produces one authenticated chunk', async () => {
  // commit rejects chunkCount < 1, so "nothing to send" must not mean
  // "no chunks" — it means one chunk carrying nothing.
  const slices = C.splitChunks(new Uint8Array(0), 1024);
  assert.equal(slices.length, 1);
  const key = C.newKey();
  const out = await C.openChunk(key, await C.sealChunk(key, slices[0]));
  assert.equal(out.length, 0);
});

test('base64url output is fragment-safe', () => {
  for (let i = 0; i < 50; i++) {
    const s = C.toB64Url(C.randomBytes(32));
    assert.match(s, /^[A-Za-z0-9_-]+$/, 'a +, / or = in the fragment would be mangled by a URL parser');
    assert.deepEqual(Buffer.from(C.fromB64(s)).length, 32);
  }
});

test('pinWrap survives the code and PIN being typed the way a person types them', async () => {
  const key = C.newKey();
  // The sender seals under what the server issued...
  const wrap = await C.wrapKeyWithPin(key, 'ABCD1234', '482719');

  // ...and the receiver types what the screen showed them. Every one of these
  // has to derive the same key, or the typed-code path fails 100% of the time
  // while looking exactly like a wrong PIN.
  for (const [code, pin] of [
    ['ABCD-1234', '482-719'],
    ['abcd-1234', '482 719'],
    ['  ABCD 1234  ', '482719'],
  ]) {
    assert.deepEqual(
      Buffer.from(await C.unwrapKeyWithPin(wrap, code, pin)), Buffer.from(key),
      `typed as ${JSON.stringify(code)} / ${JSON.stringify(pin)}`,
    );
  }
});

test('the Crockford substitutions the alphabet exists for are applied', () => {
  // I, L, O and U are excluded from the alphabet precisely because they get
  // misread. Reading a 1 back as an I has to still resolve to the same code.
  assert.equal(C.canonicalCode('IL0O-1234'), '11001234');
  assert.equal(C.canonicalPin('482-719'), '482719');
});
