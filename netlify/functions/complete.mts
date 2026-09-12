import type { Config } from '@netlify/functions';
import { transferStore, metaKey, purgeTransfer, type TransferMeta } from './_lib/store.mts';
import { safeEqualHex, sha256 } from './_lib/codes.mts';
import { ok, fail, preflight, bearer, readJson } from './_lib/http.mts';

/**
 * The receiver says "I have it all and it decrypted" and the transfer stops
 * existing — every chunk, the metadata, and the code index, so the code goes
 * back into circulation. The 30-minute expiry is the backstop for receivers
 * who never get here; this is the normal ending.
 */
export default async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'POST') return fail(req, 'bad_request');

  const token = bearer(req);
  if (!token) return fail(req, 'bad_token');

  const body = await readJson(req);
  const id = String(body?.transferId || '');
  if (!/^[0-9a-f]{32}$/.test(id)) return fail(req, 'bad_request');

  const store = transferStore();
  const meta = await store.get(metaKey(id), { type: 'json' }) as TransferMeta | null;
  // Already purged — by the sweeper, by a cancel, or by this same call
  // retried over a flaky connection. The caller wanted it gone; it is gone.
  if (!meta) return ok(req, { status: 'gone' });

  if (!safeEqualHex(sha256(token), meta.receiptTokenHash)) return fail(req, 'bad_token');

  await purgeTransfer(meta);
  return ok(req, { status: 'gone' });
};

export const config: Config = { path: '/api/complete' };
