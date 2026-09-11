import type { Config } from '@netlify/functions';
import { transferStore, purgeTransfer, type TransferMeta } from './_lib/store.mts';

/**
 * Expiry is checked on every read, but a transfer nobody ever comes back for
 * is never read — and a payload that sits in storage past its stated life is
 * exactly the promise this service makes and would be quietly breaking.
 *
 * docs/SYNC.md §2.4 lists that gap as a known limitation of Token Sync
 * ("no pg_cron, abandoned rows linger"). There is no reason to inherit it
 * here: a scheduled function is free.
 */
export default async () => {
  const store = transferStore();
  const now = Date.now();
  let scanned = 0, purged = 0;

  // Only the meta blobs — chunk and code keys are reached through the meta
  // they belong to, and listing the whole store would walk the payloads too.
  const { blobs } = await store.list({ prefix: 't/' }) as { blobs: { key: string }[] };
  for (const { key } of blobs) {
    if (!key.endsWith('/meta')) continue;
    scanned++;
    const meta = await store.get(key, { type: 'json' }) as TransferMeta | null;
    if (!meta) continue;
    if (now > meta.expiresAt) { await purgeTransfer(meta); purged++; }
  }

  console.log(`[sweep] scanned ${scanned} transfer(s), purged ${purged}`);
};

export const config: Config = { schedule: '@hourly' };
