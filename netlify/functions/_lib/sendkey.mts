import { createHmac, timingSafeEqual } from 'node:crypto';
import { transferStore } from './store.mts';
import { SENDKEY, sha256, safeEqualHex } from './codes.mts';

export { SENDKEY };

/**
 * The send key — one more thing a sender must type before /api/create will
 * open a transfer. It keeps the service from being an anonymous dead drop for
 * anyone who finds the URL: only people who were given this week's key can
 * upload, while receiving stays exactly as open as before (the code + PIN are
 * already the receiver's credential).
 *
 * WHERE IT COMES FROM. Nothing is stored. The key for week N is
 *
 *     HMAC-SHA256(TRX_SENDKEY_SECRET, "ddx-sendkey/v1/" + N)  →  60 bits
 *
 * rendered as 12 Crockford characters (XXXX-XXXX-XXXX). Consequences:
 *   - it rotates by itself every week, with no scheduled job and no race;
 *   - next week's key already exists and can be handed out before Monday —
 *     that is the "prepared" key the viewer endpoint returns alongside the
 *     current one;
 *   - the secret is the whole of it. Rotating TRX_SENDKEY_SECRET invalidates
 *     every key, current and future, at once (the emergency lever if a key
 *     leaks mid-week); it is 32 random bytes from `npm run sendkey -- secret`.
 *
 * WHO MAY SEE IT. GET /api/sendkey with `Authorization: Bearer <viewer token>`.
 * TRX_SENDKEY_VIEWERS lists `name:sha256(token)` pairs — the service never
 * holds a viewer token, only its hash, so the env var leaking hands out
 * nothing. Granting is `npm run sendkey -- grant <name>`; revoking is
 * deleting that pair.
 *
 * SWITCHED ON BY THE SECRET. With TRX_SENDKEY_SECRET unset the gate is off
 * and /api/create behaves as it always did — that is the rollout path, so this
 * can deploy before every client knows to ask for a key. A secret that is set
 * but too short is NOT treated as off: it fails closed (`send_key_unavailable`)
 * rather than silently accepting a guessable key.
 */


/** 1970-01-05 was a Monday: week 0 starts there. */
const MONDAY_EPOCH = Date.UTC(1970, 0, 5);
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function env(name: string): string | undefined {
  const v = (globalThis as any).Netlify?.env?.get?.(name);
  if (v != null) return String(v);
  return (globalThis as any).process?.env?.[name];
}

export type GateState =
  | { on: false }
  | { on: true; secret: Buffer; offsetMs: number }
  | { on: 'broken' };

/** Reads the configuration once per request — env can change between deploys. */
export function gate(): GateState {
  const raw = env('TRX_SENDKEY_SECRET');
  if (!raw) return { on: false };
  const secret = decodeSecret(raw);
  if (!secret || secret.length < SENDKEY.MIN_SECRET_BYTES) return { on: 'broken' };
  const hours = Number(env('TRX_SENDKEY_UTC_OFFSET_HOURS') ?? SENDKEY.DEFAULT_UTC_OFFSET_HOURS);
  const offsetMs = Number.isFinite(hours) && Math.abs(hours) <= 14 ? hours * 3_600_000 : SENDKEY.DEFAULT_UTC_OFFSET_HOURS * 3_600_000;
  return { on: true, secret, offsetMs };
}

/** base64url (what `npm run sendkey -- secret` prints) or hex. */
function decodeSecret(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return Buffer.from(s, 'base64url');
  return null;
}

export function weekIndex(now: number, offsetMs: number): number {
  return Math.floor((now + offsetMs - MONDAY_EPOCH) / SENDKEY.WEEK_MS);
}

export function weekStart(index: number, offsetMs: number): number {
  return MONDAY_EPOCH + index * SENDKEY.WEEK_MS - offsetMs;
}

/** The 12-character key for one week. Pure, so tests and the CLI share it. */
export function keyForWeek(secret: Buffer, index: number): string {
  const mac = createHmac('sha256', secret).update(`ddx-sendkey/v1/${index}`).digest();
  // 60 bits: the first 8 bytes as a big integer, 12 five-bit groups of it.
  let n = mac.readBigUInt64BE(0) >> 4n;
  let out = '';
  for (let i = 0; i < 12; i++) { out = ALPHABET[Number(n & 31n)] + out; n >>= 5n; }
  return out;
}

export const displaySendKey = (k: string) => `${k.slice(0, 4)}-${k.slice(4, 8)}-${k.slice(8)}`;

/** Same forgiveness as normalizeCode: case, spaces, hyphens, I/L→1, O→0. */
export function normalizeSendKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.length !== 12) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Current week's key, or last week's inside the grace window after rollover. */
export function sendKeyMatches(g: Extract<GateState, { on: true }>, typed: string, now = Date.now()): boolean {
  const idx = weekIndex(now, g.offsetMs);
  if (sameKey(typed, keyForWeek(g.secret, idx))) return true;
  const sinceRollover = now - weekStart(idx, g.offsetMs);
  return sinceRollover < SENDKEY.GRACE_MS && sameKey(typed, keyForWeek(g.secret, idx - 1));
}

export function describeWeek(g: Extract<GateState, { on: true }>, index: number) {
  const key = keyForWeek(g.secret, index);
  return {
    key,
    keyDisplay: displaySendKey(key),
    week: index,
    validFrom: weekStart(index, g.offsetMs),
    validUntil: weekStart(index + 1, g.offsetMs) + SENDKEY.GRACE_MS,
  };
}

/* ---- viewers --------------------------------------------------------- */

/** `alice:<64 hex>,bob:<64 hex>` → [{ name, hash }]. Malformed pairs are dropped. */
export function viewers(): { name: string; hash: string }[] {
  const raw = env('TRX_SENDKEY_VIEWERS') || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const i = pair.lastIndexOf(':');
    return { name: pair.slice(0, i).trim(), hash: pair.slice(i + 1).trim().toLowerCase() };
  }).filter((v) => v.name && /^[0-9a-f]{64}$/.test(v.hash));
}

/** The viewer a bearer token belongs to, checking every entry in constant time. */
export function viewerFor(token: string | null): string | null {
  if (!token) return null;
  const h = sha256(token);
  let found: string | null = null;
  for (const v of viewers()) if (safeEqualHex(h, v.hash) && !found) found = v.name;
  return found;
}

/* ---- failed-attempt limiter ------------------------------------------ */

/**
 * Both secrets here are far beyond guessing (60-bit key, 256-bit tokens), so
 * this is not what makes them safe — it is what keeps someone from using the
 * endpoints as a free oracle or filling the logs. Keyed by an HMAC of the
 * client IP under the send-key secret: an IPv4 address hashed plainly is
 * reversible by enumeration, and the store has no business holding one.
 */
export const failKey = (kind: 'create' | 'view', clientId: string) => `sk-fail/${kind}/${clientId}`;

export function clientId(req: Request, g: GateState): string {
  const ip = req.headers.get('x-nf-client-connection-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'unknown';
  const salt = g.on === true ? g.secret : Buffer.from('ddx-sendkey-off');
  return createHmac('sha256', salt).update(`ip/${ip}`).digest('hex').slice(0, 32);
}

interface FailRecord { count: number; windowStart: number }

export async function isLockedOut(kind: 'create' | 'view', id: string, now = Date.now()): Promise<boolean> {
  const rec = await transferStore().get(failKey(kind, id), { type: 'json' }) as FailRecord | null;
  return !!rec && now - rec.windowStart < SENDKEY.FAIL_WINDOW_MS && rec.count >= SENDKEY.MAX_FAILS;
}

export async function recordFailure(kind: 'create' | 'view', id: string, now = Date.now()) {
  const store = transferStore();
  const key = failKey(kind, id);
  const rec = await store.get(key, { type: 'json' }) as FailRecord | null;
  const fresh = !rec || now - rec.windowStart >= SENDKEY.FAIL_WINDOW_MS;
  await store.setJSON(key, fresh ? { count: 1, windowStart: now } : { count: rec!.count + 1, windowStart: rec!.windowStart });
}

/** Swept hourly alongside expired transfers. */
export async function sweepFailures(now = Date.now()): Promise<number> {
  const store = transferStore();
  const { blobs } = await store.list({ prefix: 'sk-fail/' }) as { blobs: { key: string }[] };
  let n = 0;
  for (const { key } of blobs) {
    const rec = await store.get(key, { type: 'json' }) as FailRecord | null;
    if (!rec || now - rec.windowStart >= SENDKEY.FAIL_WINDOW_MS) { await store.delete(key); n++; }
  }
  return n;
}
