import type { Config } from '@netlify/functions';
import { transferStore, metaKey, codeKey, purgeTransfer, type TransferMeta } from './_lib/store.mts';
import { LIMITS, normalizeCode, normalizePin, hashPin, mintToken, newSalt, safeEqualHex } from './_lib/codes.mts';
import { ok, fail, preflight, readJson, expired } from './_lib/http.mts';

/**
 * Step one of the two-step receive. It hands back the SEALED manifest and a
 * receipt token — never a byte of payload. The receiver opens the manifest
 * locally with the transfer key and shows "Project / Size / Created" so a
 * person can see what they are about to import before it touches their vault.
 */
export default async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'POST') return fail(req, 'bad_request');

  const body = await readJson(req);
  const code = normalizeCode(body?.code);
  const pin = normalizePin(body?.pin);
  if (!code || !pin) {
    // Burn comparable time on a malformed attempt too. Answering instantly
    // here while a real code costs ~80ms of PBKDF2 would let someone map the
    // code space by stopwatch without ever guessing a PIN.
    hashPin('0'.repeat(8), '000000', newSalt());
    return fail(req, 'bad_code');
  }

  const store = transferStore();
  const index = await store.get(codeKey(code), { type: 'json' }) as { transferId: string } | null;
  if (!index) { hashPin(code, pin, newSalt()); return fail(req, 'bad_code'); }

  const meta = await store.get(metaKey(index.transferId), { type: 'json' }) as TransferMeta | null;
  if (!meta) { await store.delete(codeKey(code)); return fail(req, 'gone'); }

  if (expired(meta)) { await purgeTransfer(meta); return fail(req, 'expired'); }

  const now = Date.now();
  if (meta.lockedUntil > now) {
    return fail(req, 'locked', { retryAfterMs: meta.lockedUntil - now });
  }

  if (!safeEqualHex(hashPin(code, pin, meta.pinSalt), meta.pinHash)) {
    const failCount = meta.failCount + 1;
    const lockedUntil = failCount >= LIMITS.MAX_PIN_FAILS ? now + LIMITS.LOCK_MS : meta.lockedUntil;
    // Reset the counter when the lock is armed, so serving the lock once does
    // not leave the transfer permanently one guess from re-locking.
    await store.setJSON(metaKey(meta.id), {
      ...meta,
      failCount: lockedUntil > now ? 0 : failCount,
      lockedUntil,
    } satisfies TransferMeta);
    return lockedUntil > now
      ? fail(req, 'locked', { retryAfterMs: LIMITS.LOCK_MS })
      : fail(req, 'bad_code', { attemptsLeft: LIMITS.MAX_PIN_FAILS - failCount });
  }

  // Right code, right PIN — but the sender may still be uploading.
  if (meta.status !== 'waiting') return fail(req, 'not_ready');

  // A fresh receipt token per successful Verify. Re-verifying (a reloaded
  // page, a retried scan) is legitimate and simply retires the previous one.
  const receipt = mintToken();
  await store.setJSON(metaKey(meta.id), {
    ...meta, failCount: 0, lockedUntil: 0, receiptTokenHash: receipt.hash,
  } satisfies TransferMeta);

  return ok(req, {
    transferId: meta.id,
    receiptToken: receipt.token,
    chunkCount: meta.chunkCount,
    sizeBytes: meta.sizeBytes,
    manifestEnc: meta.manifestEnc,
    // null here means the sender turned the typed-code flow off: the key is
    // only in the QR/link fragment, and a client that got here by typing has
    // nothing to decrypt with.
    pinWrap: meta.pinWrap,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
  });
};

export const config: Config = { path: '/api/verify' };
