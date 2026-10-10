/**
 * The error vocabulary. Clients map these to their own i18n keys — no raw
 * error string from this service ever reaches a DraconDex toast, which is the
 * same rule electron/src/db/sync.js follows for the Supabase RPCs.
 *
 * `bad_code` deliberately covers BOTH "no such code" and "wrong PIN". Telling
 * those apart would turn the 8-character code into an oracle you can confirm
 * hits against without ever knowing a PIN.
 */
export type ErrCode =
  | 'bad_request' | 'bad_code' | 'locked' | 'expired' | 'gone'
  | 'bad_token' | 'too_large' | 'not_ready' | 'server_error'
  | 'send_key_required' | 'bad_send_key' | 'send_key_unavailable';

/**
 * The three send-key codes (see _lib/sendkey.mts) are told apart on purpose,
 * unlike bad_code: `send_key_required` is how a client learns it must ask the
 * user for a key at all, and `bad_send_key` cannot be an oracle — there is one
 * valid key per week, the same for everyone, so confirming a wrong guess says
 * nothing about anyone's transfer.
 */
const STATUS: Record<ErrCode, number> = {
  bad_request: 400, bad_code: 403, locked: 429, expired: 410, gone: 410,
  bad_token: 401, too_large: 413, not_ready: 409, server_error: 500,
  send_key_required: 401, bad_send_key: 403, send_key_unavailable: 503,
};

/**
 * CORS is normally a thing you do not add to a Netlify site unless asked. It
 * is asked for here: the PWA lanes run on GitHub Pages and the Flutter web
 * build runs from a different origin again, so both are cross-origin callers
 * by construction. The Electron main process is not — it fetches from Node
 * with no Origin header at all and never triggers a preflight.
 */
function allowedOrigins(): string[] {
  const env = (globalThis as any).Netlify?.env?.get?.('DDX_ALLOWED_ORIGINS');
  if (env) return String(env).split(',').map((s) => s.trim()).filter(Boolean);
  return [
    'https://zydraxyl.github.io',
    'http://localhost:8888',
    'http://localhost:8080',
    'http://127.0.0.1:8888',
  ];
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  const self = new URL(req.url).origin;
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && (origin === self || allowedOrigins().includes(origin))) {
    h['Access-Control-Allow-Origin'] = origin;
  }
  return h;
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(req) },
  });
}

export const ok = (req: Request, body: Record<string, unknown> = {}) => json(req, { ok: true, ...body });

export const fail = (req: Request, code: ErrCode, extra: Record<string, unknown> = {}) =>
  json(req, { ok: false, code, ...extra }, STATUS[code]);

export function bytes(req: Request, body: ArrayBuffer | Uint8Array): Response {
  return new Response(body as any, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', ...corsHeaders(req) },
  });
}

export const preflight = (req: Request) => new Response(null, { status: 204, headers: corsHeaders(req) });

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/** Reads and parses a JSON body, returning null rather than throwing. */
export async function readJson(req: Request): Promise<Record<string, any> | null> {
  try {
    const v = await req.json();
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

export const expired = (meta: { expiresAt: number }) => Date.now() > meta.expiresAt;
