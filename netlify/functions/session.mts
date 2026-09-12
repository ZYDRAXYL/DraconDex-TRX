import type { Config, Context } from '@netlify/functions';
import { transferStore, metaKey, purgeTransfer, type TransferMeta } from './_lib/store.mts';
import { safeEqualHex, sha256 } from './_lib/codes.mts';
import { ok, fail, preflight, bearer, expired } from './_lib/http.mts';

/**
 * The sender's two views of its own transfer: poll it, or call it off. Both
 * need the upload token and nothing else — there is no account to check
 * against, which is the entire point of this service.
 */
export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return preflight(req);

  const id = String(context.params?.id || '');
  if (!/^[0-9a-f]{32}$/.test(id)) return fail(req, 'bad_request');

  const token = bearer(req);
  if (!token) return fail(req, 'bad_token');

  const store = transferStore();
  const meta = await store.get(metaKey(id), { type: 'json' }) as TransferMeta | null;

  // A cancel on something already gone is a success, not an error — the
  // sender asked for it not to exist and it does not exist.
  if (!meta) return req.method === 'DELETE' ? ok(req, { status: 'gone' }) : fail(req, 'gone');
  if (!safeEqualHex(sha256(token), meta.uploadTokenHash)) return fail(req, 'bad_token');

  if (req.method === 'DELETE') {
    await purgeTransfer(meta);
    return ok(req, { status: 'gone' });
  }

  if (req.method === 'GET') {
    if (expired(meta)) {
      await purgeTransfer(meta);
      return ok(req, { status: 'expired', expiresAt: meta.expiresAt });
    }
    return ok(req, {
      status: meta.status,
      // Whether anyone has passed Verify yet is what the sender's "Waiting
      // for receiver…" line is actually waiting on.
      claimed: meta.receiptTokenHash !== null,
      expiresAt: meta.expiresAt,
    });
  }

  return fail(req, 'bad_request');
};

export const config: Config = { path: ['/api/status/:id', '/api/cancel/:id'] };
