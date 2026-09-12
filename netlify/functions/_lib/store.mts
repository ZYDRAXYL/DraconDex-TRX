import { getStore, getDeployStore } from '@netlify/blobs';

const STORE_NAME = 'ddx-transfers';

/**
 * Every read here is a read-modify-write on a counter that gates access
 * (`failCount`/`lockedUntil`), so the default eventual consistency is wrong:
 * a receiver could spend its 5 PIN guesses against a stale copy and never
 * trip the lock. `strong` costs latency on reads and buys correctness on the
 * only thing in this service that has to be correct.
 */
function opts() {
  return { name: STORE_NAME, consistency: 'strong' as const };
}

/**
 * Production writes to the global store; deploy previews and branch deploys
 * get their own deploy-scoped store so a preview can never read, overwrite,
 * or sweep a real transfer.
 */
export function transferStore() {
  const isProd = (globalThis as any).Netlify?.context?.deploy?.context === 'production';
  return isProd ? getStore(opts()) : getDeployStore(opts());
}

export const metaKey  = (id: string) => `t/${id}/meta`;
export const chunkKey = (id: string, n: number) => `t/${id}/c/${n}`;
export const codeKey  = (code: string) => `code/${code}`;

export interface TransferMeta {
  v: 1;
  id: string;
  code: string;
  pinSalt: string;
  pinHash: string;
  failCount: number;
  lockedUntil: number;
  status: 'open' | 'waiting' | 'received';
  chunkCount: number;
  sizeBytes: number;
  manifestEnc: unknown | null;
  pinWrap: unknown | null;
  uploadTokenHash: string;
  receiptTokenHash: string | null;
  createdAt: number;
  expiresAt: number;
}

/**
 * Removes every blob belonging to one transfer, code index included so the
 * 8-character code goes back into circulation.
 *
 * The chunks are found by LISTING the prefix, not by walking 0..chunkCount:
 * a sender that uploads and then never commits leaves `chunkCount` at 0, and
 * counting would walk zero of its real chunks and leak the payload in storage
 * forever — the one leak in this service that would outlive its own expiry
 * promise. Deleting a key that is not there resolves fine, so this is safe on
 * a half-built transfer and safe to call twice.
 */
export async function purgeTransfer(meta: Pick<TransferMeta, 'id' | 'code'>) {
  const store = transferStore();
  const { blobs } = await store.list({ prefix: `t/${meta.id}/` }) as { blobs: { key: string }[] };
  await Promise.all([
    store.delete(codeKey(meta.code)),
    ...blobs.map((b) => store.delete(b.key)),
  ]);
}
