import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

/**
 * The send key (_lib/sendkey.mts) through the real handlers: /api/create
 * refuses without this week's key, /api/sendkey hands it — and next week's —
 * only to a listed viewer, and both lock a client out after repeated misses.
 * The blob store is in memory and the Netlify env is a plain object, so each
 * test sets exactly the configuration it is about.
 */
function makeStore() {
  const data = new Map();
  return {
    _data: data,
    async get(key, opts) {
      if (!data.has(key)) return null;
      const v = data.get(key);
      return opts?.type === 'json' ? JSON.parse(v) : v;
    },
    async set(key, value) { data.set(key, String(value)); },
    async setJSON(key, value) { data.set(key, JSON.stringify(value)); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) {
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

let store = makeStore();
mock.module('@netlify/blobs', { namedExports: { getStore: () => store, getDeployStore: () => store } });

let ENV = {};
globalThis.Netlify = { env: { get: (k) => ENV[k] } };

const { default: create } = await import('../netlify/functions/create.mts');
const { default: viewKey } = await import('../netlify/functions/sendkey.mts');
const { default: sweep } = await import('../netlify/functions/sweep.mts');
const SK = await import('../netlify/functions/_lib/sendkey.mts');

const ORIGIN = 'https://transfer.example';
const SECRET = randomBytes(32).toString('base64url');
const VIEWER_TOKEN = randomBytes(32).toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest('hex');

const createReq = (body, ip = '203.0.113.7') => new Request(`${ORIGIN}/api/create`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': ip },
  body: JSON.stringify(body),
});
const viewReq = (token, ip = '203.0.113.7') => new Request(`${ORIGIN}/api/sendkey`, {
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-nf-client-connection-ip': ip },
});
const json = (res) => res.json();

function currentKey(now = Date.now()) {
  const g = SK.gate();
  return SK.keyForWeek(g.secret, SK.weekIndex(now, g.offsetMs));
}

test.beforeEach(() => {
  store = makeStore();
  ENV = { TRX_SENDKEY_SECRET: SECRET, TRX_SENDKEY_VIEWERS: `alice:${sha(VIEWER_TOKEN)}` };
});

/* ---- the gate on /api/create ------------------------------------------- */

test('with no secret configured the gate is off — the rollout path', async () => {
  ENV = {};
  const r = await json(await create(createReq({ sizeBytes: 10 })));
  assert.equal(r.ok, true);
});

test('a set-but-short secret fails closed instead of opening the gate', async () => {
  ENV = { TRX_SENDKEY_SECRET: 'abcd' };
  const res = await create(createReq({ sizeBytes: 10, sendKey: 'whatever' }));
  assert.equal(res.status, 503);
  assert.equal((await json(res)).code, 'send_key_unavailable');
  assert.equal(store._data.size, 0, 'nothing written');
});

test('no key → send_key_required, and nothing is claimed', async () => {
  const res = await create(createReq({ sizeBytes: 10 }));
  assert.equal(res.status, 401);
  assert.equal((await json(res)).code, 'send_key_required');
  assert.equal([...store._data.keys()].filter((k) => !k.startsWith('sk-fail/')).length, 0);
});

test('a wrong key → bad_send_key; this week\'s key opens a transfer, however it is typed', async () => {
  const bad = await create(createReq({ sizeBytes: 10, sendKey: 'AAAA-AAAA-AAAA' }));
  assert.equal(bad.status, 403);
  assert.equal((await json(bad)).code, 'bad_send_key');

  const k = currentKey();
  const messy = ` ${k.slice(0, 4).toLowerCase()} ${k.slice(4, 8)}-${k.slice(8)} `;
  const r = await json(await create(createReq({ sizeBytes: 10, sendKey: messy })));
  assert.equal(r.ok, true);
  assert.match(r.code, /^[0-9A-Z]{8}$/);
});

test('ten misses lock that client out — even the right key — and nobody else', async () => {
  for (let i = 0; i < SK.SENDKEY.MAX_FAILS; i++) {
    await create(createReq({ sizeBytes: 10, sendKey: 'AAAA-AAAA-AAAA' }));
  }
  const locked = await create(createReq({ sizeBytes: 10, sendKey: currentKey() }));
  assert.equal(locked.status, 429);
  const other = await json(await create(createReq({ sizeBytes: 10, sendKey: currentKey() }, '198.51.100.9')));
  assert.equal(other.ok, true);
});

test('the lockout counter stores no IP address, and sweep clears it once its window passes', async () => {
  await create(createReq({ sizeBytes: 10, sendKey: 'AAAA-AAAA-AAAA' }));
  const keys = [...store._data.keys()].filter((k) => k.startsWith('sk-fail/'));
  assert.equal(keys.length, 1);
  assert.ok(!keys[0].includes('203.0.113.7'));
  assert.ok(!store._data.get(keys[0]).includes('203.0.113.7'));

  const rec = JSON.parse(store._data.get(keys[0]));
  rec.windowStart -= SK.SENDKEY.FAIL_WINDOW_MS + 1;
  store._data.set(keys[0], JSON.stringify(rec));
  await sweep();
  assert.equal([...store._data.keys()].filter((k) => k.startsWith('sk-fail/')).length, 0);
});

/* ---- rotation ----------------------------------------------------------- */

test('the key changes every week, at Monday 00:00 in the configured offset', () => {
  const g = SK.gate();
  assert.equal(g.offsetMs, 7 * 3_600_000, 'Thailand by default');
  // Monday 2026-10-12 00:00 +07:00 = Sunday 17:00 UTC.
  const monday = Date.UTC(2026, 9, 11, 17, 0, 0);
  const before = SK.weekIndex(monday - 1, g.offsetMs);
  const after = SK.weekIndex(monday, g.offsetMs);
  assert.equal(after, before + 1);
  assert.equal(SK.weekStart(after, g.offsetMs), monday);
  assert.notEqual(SK.keyForWeek(g.secret, before), SK.keyForWeek(g.secret, after));
  assert.equal(SK.keyForWeek(g.secret, after), SK.keyForWeek(g.secret, after), 'deterministic');
});

test('last week\'s key still works for two hours after the rollover, then stops', () => {
  const g = SK.gate();
  const monday = Date.UTC(2026, 9, 11, 17, 0, 0);
  const last = SK.keyForWeek(g.secret, SK.weekIndex(monday - 1, g.offsetMs));
  assert.equal(SK.sendKeyMatches(g, last, monday + 60_000), true);
  assert.equal(SK.sendKeyMatches(g, last, monday + SK.SENDKEY.GRACE_MS + 1), false);
  const next = SK.keyForWeek(g.secret, SK.weekIndex(monday, g.offsetMs) + 1);
  assert.equal(SK.sendKeyMatches(g, next, monday), false, 'next week\'s key is not valid early');
});

test('a different secret yields different keys — rotating it revokes everything', () => {
  const idx = 2000;
  const a = SK.keyForWeek(Buffer.from(SECRET, 'base64url'), idx);
  const b = SK.keyForWeek(randomBytes(32), idx);
  assert.notEqual(a, b);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{12}$/);
});

/* ---- /api/sendkey ------------------------------------------------------- */

test('a listed viewer gets this week\'s key and next week\'s prepared one', async () => {
  const r = await json(await viewKey(viewReq(VIEWER_TOKEN)));
  assert.equal(r.ok, true);
  assert.equal(r.viewer, 'alice');
  assert.equal(r.current.key, currentKey());
  assert.equal(r.next.week, r.current.week + 1);
  assert.equal(r.next.validFrom, r.current.validUntil - SK.SENDKEY.GRACE_MS);
  assert.match(r.current.keyDisplay, /^.{4}-.{4}-.{4}$/);

  const opened = await json(await create(createReq({ sizeBytes: 1, sendKey: r.current.keyDisplay })));
  assert.equal(opened.ok, true, 'what a viewer reads is what a sender types');
});

test('no token, a wrong token, or a revoked one → bad_token, and the response says nothing else', async () => {
  for (const t of [null, 'nope', randomBytes(32).toString('base64url')]) {
    const res = await viewKey(viewReq(t));
    assert.equal(res.status, 401);
    const r = await json(res);
    assert.deepEqual(Object.keys(r).sort(), ['code', 'ok']);
  }
  ENV.TRX_SENDKEY_VIEWERS = ''; // alice revoked
  assert.equal((await viewKey(viewReq(VIEWER_TOKEN))).status, 401);
});

test('viewer guessing is locked out per client too', async () => {
  for (let i = 0; i < SK.SENDKEY.MAX_FAILS; i++) await viewKey(viewReq('guess'));
  assert.equal((await viewKey(viewReq(VIEWER_TOKEN))).status, 429);
  assert.equal((await viewKey(viewReq(VIEWER_TOKEN, '198.51.100.9'))).status, 200);
});

test('with the gate off there is no key to view', async () => {
  ENV = { TRX_SENDKEY_VIEWERS: `alice:${sha(VIEWER_TOKEN)}` };
  const res = await viewKey(viewReq(VIEWER_TOKEN));
  assert.equal(res.status, 503);
});

test('the response is never cached', async () => {
  const res = await viewKey(viewReq(VIEWER_TOKEN));
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
