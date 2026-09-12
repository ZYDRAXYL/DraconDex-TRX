import type { Config } from '@netlify/functions';
import { transferStore, metaKey, chunkKey, type TransferMeta } from './_lib/store.mts';
import { LIMITS, safeEqualHex, sha256 } from './_lib/codes.mts';
import { ok, fail, preflight, bearer, readJson, expired } from './_lib/http.mts';

/** An { iv, ct } pair, both base64. Nothing here ever looks inside `ct`. */
function isSealed(v: any): boolean {
  return !!v && typeof v === 'object'
    && typeof v.iv === 'string' && v.iv.length > 0 && v.iv.length <= 64
    && typeof v.ct === 'string' && v.ct.length > 0 && v.ct.length <= 8192;
}

/** As above plus the KDF parameters the receiver needs to rebuild the key. */
function isPinWrap(v: any): boolean {
  return isSealed(v) && typeof v.salt === 'string' && v.salt.length > 0 && v.salt.length <= 64
    && Number.isInteger(v.iters) && v.iters >= 100_000 && v.iters <= 2_000_000;
}

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
  if (!meta) return fail(req, 'gone');
  if (!safeEqualHex(sha256(token), meta.uploadTokenHash)) return fail(req, 'bad_token');
  if (expired(meta)) return fail(req, 'expired');
  if (meta.status !== 'open') return fail(req, 'not_ready');

  const chunkCount = Number(body?.chunkCount);
  const sizeBytes = Number(body?.sizeBytes);
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > LIMITS.MAX_CHUNKS) return fail(req, 'bad_request');
  if (!Number.isFinite(sizeBytes) || sizeBytes < 1 || sizeBytes > LIMITS.MAX_TOTAL_BYTES) return fail(req, 'bad_request');

  // The manifest (project name, size, timestamp) is sealed under the same key
  // as the payload, so this service never learns what anyone is sending —
  // only that someone is. The receiver opens it locally and draws the
  // confirmation card from what comes out.
  if (!isSealed(body?.manifestEnc)) return fail(req, 'bad_request');

  // Optional by design. Present = the sender allowed the typed-code flow, and
  // the transfer key is on this server sealed under the PIN. Absent = the key
  // exists only in the QR/link fragment and this service cannot read the
  // payload at all, however the transfer ends.
  const pinWrap = body?.pinWrap ?? null;
  if (pinWrap !== null && !isPinWrap(pinWrap)) return fail(req, 'bad_request');

  // Verifying the chunks are actually there closes the window where a
  // receiver passes Verify, presses Receive, and only then discovers the
  // upload was half-finished.
  const present = await Promise.all(
    Array.from({ length: chunkCount }, (_, n) => store.getMetadata(chunkKey(id, n))),
  );
  if (present.some((p) => p === null)) return fail(req, 'not_ready', { missing: true });

  const next: TransferMeta = {
    ...meta,
    status: 'waiting',
    chunkCount,
    sizeBytes,
    manifestEnc: body.manifestEnc,
    pinWrap,
  };
  await store.setJSON(metaKey(id), next);

  return ok(req, { status: 'waiting', expiresAt: next.expiresAt });
};

export const config: Config = { path: '/api/commit' };
