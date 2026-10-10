import type { Config } from '@netlify/functions';
import { ok, fail, preflight, bearer } from './_lib/http.mts';
import { gate, weekIndex, describeWeek, viewerFor, clientId, isLockedOut, recordFailure } from './_lib/sendkey.mts';

/**
 * GET /api/sendkey — this week's send key and next week's, for the people
 * allowed to hand it out. `Authorization: Bearer <viewer token>`; the tokens
 * are granted per person with `npm run sendkey -- grant <name>` and listed
 * (as hashes) in TRX_SENDKEY_VIEWERS. See _lib/sendkey.mts.
 *
 * Next week's key is returned on purpose: it is the "prepared" key, so it can
 * be passed on before Monday and nobody is locked out at the rollover.
 *
 * A wrong token and a missing one look the same (`bad_token`) and both count
 * toward the per-client lockout. Nothing about the request is logged.
 */
export default async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'GET') return fail(req, 'bad_request');

  const g = gate();
  if (g.on !== true) return fail(req, 'send_key_unavailable', { enabled: g.on === false ? false : undefined });

  const who = clientId(req, g);
  if (await isLockedOut('view', who)) return fail(req, 'locked');

  const viewer = viewerFor(bearer(req));
  if (!viewer) {
    await recordFailure('view', who);
    return fail(req, 'bad_token');
  }

  const idx = weekIndex(Date.now(), g.offsetMs);
  return ok(req, { viewer, current: describeWeek(g, idx), next: describeWeek(g, idx + 1) });
};

export const config: Config = { path: '/api/sendkey' };
