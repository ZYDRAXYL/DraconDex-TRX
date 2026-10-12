import { randomBytes, randomInt, createHash, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

/**
 * One place for every number the service enforces. `/api/create` hands
 * MAX_CHUNK_BYTES to the client instead of letting each client hardcode it —
 * Netlify's synchronous-function payload ceiling is a platform number, not
 * ours, and the day it moves this is the only line that changes.
 */
export const LIMITS = {
  /** Well under Netlify's ~6 MB synchronous function payload ceiling. */
  MAX_CHUNK_BYTES: 3 * 1024 * 1024,
  MAX_TOTAL_BYTES: 100 * 1024 * 1024,
  MAX_CHUNKS: 64,
  TTL_MS: 30 * 60 * 1000,
  MAX_PIN_FAILS: 5,
  LOCK_MS: 15 * 60 * 1000,
  PBKDF2_ITERS: 100_000,
} as const;

/** The send key's numbers — see _lib/sendkey.mts for what each one guards. */
export const SENDKEY = {
  WEEK_MS: 7 * 24 * 60 * 60 * 1000,
  /** A key typed in the last minutes of a week still works this long after. */
  GRACE_MS: 2 * 60 * 60 * 1000,
  /** Wrong keys (or viewer tokens) per client before it is locked out. */
  MAX_FAILS: 10,
  FAIL_WINDOW_MS: 15 * 60 * 1000,
  MIN_SECRET_BYTES: 32,
  /** Weeks start Monday 00:00 at this UTC offset — Thailand by default. */
  DEFAULT_UTC_OFFSET_HOURS: 7,
} as const;

/**
 * Crockford Base32 minus I, L, O and U — the four that get misread or
 * mistyped when a code is read aloud down a phone line, which is exactly how
 * these travel. 8 characters is ~40 bits.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateCode(): string {
  let out = '';
  // randomInt, not Math.random — same rule generateToken() follows in
  // electron/src/db/sync.js. A predictable code is a readable vault.
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(0, ALPHABET.length)];
  return out;
}

/**
 * Accepts what a human actually types: lower case, spaces, the display
 * hyphen, and the I/L/O substitutions Crockford exists to forgive. Returns
 * null when the result is not a well-formed code, so callers never have to
 * validate separately.
 */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.length !== 8) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

export const displayCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * Six digits, not four. In the typed-code flow the server stores `pinWrap` —
 * the transfer key sealed under this PIN — so the PIN is key material against
 * anyone who can read the blob store offline, not just a doorbell the lockout
 * protects. Four digits is 10^4 and falls in milliseconds; six is 100x that
 * for one extra keypress on the sender's screen.
 */
export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function normalizePin(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).replace(/[^0-9]/g, '');
  return /^[0-9]{6}$/.test(s) ? s : null;
}

export const displayPin = (pin: string) => `${pin.slice(0, 3)}-${pin.slice(3)}`;

export function hashPin(code: string, pin: string, saltHex: string): string {
  return pbkdf2Sync(`${code}:${pin}`, Buffer.from(saltHex, 'hex'), LIMITS.PBKDF2_ITERS, 32, 'sha256')
    .toString('hex');
}

export const newSalt = () => randomBytes(16).toString('hex');

/** Mints a bearer token and the hash that is all the server keeps of it. */
export function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Constant-time hex compare — a length mismatch is a mismatch, not a throw. */
export function safeEqualHex(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
  catch { return false; }
}

export const newTransferId = () => randomBytes(16).toString('hex');
