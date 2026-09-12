import type { Config } from '@netlify/functions';
import { transferStore, metaKey, codeKey, type TransferMeta } from './_lib/store.mts';
import { LIMITS, generateCode, generatePin, displayCode, displayPin, hashPin, newSalt, mintToken, newTransferId } from './_lib/codes.mts';
import { ok, fail, preflight, readJson } from './_lib/http.mts';

export default async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'POST') return fail(req, 'bad_request');

  const body = await readJson(req);
  const sizeBytes = Number(body?.sizeBytes ?? 0);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return fail(req, 'bad_request');
  // Reject before the sender spends a minute uploading, not after.
  if (sizeBytes > LIMITS.MAX_TOTAL_BYTES) {
    return fail(req, 'too_large', { maxTotalBytes: LIMITS.MAX_TOTAL_BYTES });
  }

  const store = transferStore();
  const now = Date.now();
  const id = newTransferId();

  // ~40 bits of code against at most a few thousand live transfers: a
  // collision is remote, but "remote" and "impossible" differ, and a
  // collision would hand one sender's vault to the wrong receiver. Claim the
  // code index first and only keep a code nothing already answers to.
  let code = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCode();
    if (await store.get(codeKey(candidate)) === null) { code = candidate; break; }
  }
  if (!code) return fail(req, 'server_error');

  const pin = generatePin();
  const pinSalt = newSalt();
  const upload = mintToken();

  const meta: TransferMeta = {
    v: 1,
    id,
    code,
    pinSalt,
    pinHash: hashPin(code, pin, pinSalt),
    failCount: 0,
    lockedUntil: 0,
    status: 'open',
    chunkCount: 0,
    sizeBytes: 0,
    manifestEnc: null,
    pinWrap: null,
    uploadTokenHash: upload.hash,
    receiptTokenHash: null,
    createdAt: now,
    expiresAt: now + LIMITS.TTL_MS,
  };

  // Meta before index: a code that resolves to a missing transfer is a
  // confusing dead end, while an index-less transfer is simply invisible and
  // gets swept.
  await store.setJSON(metaKey(id), meta);
  await store.setJSON(codeKey(code), { transferId: id });

  return ok(req, {
    transferId: id,
    code,
    codeDisplay: displayCode(code),
    pin,
    pinDisplay: displayPin(pin),
    uploadToken: upload.token,
    maxChunkBytes: LIMITS.MAX_CHUNK_BYTES,
    maxTotalBytes: LIMITS.MAX_TOTAL_BYTES,
    maxChunks: LIMITS.MAX_CHUNKS,
    expiresAt: meta.expiresAt,
  });
};

export const config: Config = { path: '/api/create' };
