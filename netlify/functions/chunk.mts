import type { Config, Context } from '@netlify/functions';
import { transferStore, metaKey, chunkKey, type TransferMeta } from './_lib/store.mts';
import { LIMITS, safeEqualHex, sha256 } from './_lib/codes.mts';
import { ok, fail, bytes, preflight, bearer, expired } from './_lib/http.mts';

/**
 * One function for both directions of a chunk because Netlify routes on path,
 * not method — and the two really are the same resource. Which bearer token
 * the caller holds decides which half they get: the sender's `uploadToken`
 * can only write, the receiver's `receiptToken` can only read. Neither can do
 * the other's job.
 *
 * The transfer id rides in the path rather than a custom header on purpose —
 * a custom request header has to be named in Access-Control-Allow-Headers or
 * the browser lanes fail at preflight with nothing useful in the console.
 */
export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') return preflight(req);

  const id = String(context.params?.id || '');
  const n = Number(context.params?.n);
  if (!/^[0-9a-f]{32}$/.test(id)) return fail(req, 'bad_request');
  if (!Number.isInteger(n) || n < 0 || n >= LIMITS.MAX_CHUNKS) return fail(req, 'bad_request');

  const token = bearer(req);
  if (!token) return fail(req, 'bad_token');
  const tokenHash = sha256(token);

  const store = transferStore();
  const meta = await store.get(metaKey(id), { type: 'json' }) as TransferMeta | null;
  if (!meta) return fail(req, 'gone');
  if (expired(meta)) return fail(req, 'expired');

  if (req.method === 'PUT') {
    if (!safeEqualHex(tokenHash, meta.uploadTokenHash)) return fail(req, 'bad_token');
    // Once committed, the payload is what the receiver verified against. A
    // late write would swap the bytes under someone who already read the
    // manifest and pressed Receive.
    if (meta.status !== 'open') return fail(req, 'not_ready');

    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.byteLength === 0) return fail(req, 'bad_request');
    if (buf.byteLength > LIMITS.MAX_CHUNK_BYTES) {
      return fail(req, 'too_large', { maxChunkBytes: LIMITS.MAX_CHUNK_BYTES });
    }
    await store.set(chunkKey(id, n), buf);
    return ok(req, { index: n, bytes: buf.byteLength });
  }

  if (req.method === 'GET') {
    if (!safeEqualHex(tokenHash, meta.receiptTokenHash)) return fail(req, 'bad_token');
    if (meta.status !== 'waiting') return fail(req, 'not_ready');
    if (n >= meta.chunkCount) return fail(req, 'bad_request');

    const data = await store.get(chunkKey(id, n), { type: 'arrayBuffer' }) as ArrayBuffer | null;
    if (!data) return fail(req, 'gone');
    return bytes(req, data);
  }

  return fail(req, 'bad_request');
};

export const config: Config = { path: '/api/chunk/:id/:n' };
