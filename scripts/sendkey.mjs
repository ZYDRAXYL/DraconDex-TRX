#!/usr/bin/env node
// Admin side of the send key (netlify/functions/_lib/sendkey.mts). Runs on
// the operator's machine; nothing here talks to the deployed service.
//
//   npm run sendkey -- secret              a new TRX_SENDKEY_SECRET (32 random bytes)
//   npm run sendkey -- grant <name>        a viewer token for one person, plus the
//                                          name:hash pair to add to TRX_SENDKEY_VIEWERS
//   npm run sendkey -- keys [--weeks 4]    this week's key and the next N, prepared
//                                          ahead (needs TRX_SENDKEY_SECRET in the env)
//
// The token from `grant` is printed ONCE and never stored anywhere — the
// service keeps only its SHA-256. Hand it to the person over a channel you
// trust; if it leaks, delete their pair from TRX_SENDKEY_VIEWERS and grant
// again. If a KEY leaks mid-week, rotate TRX_SENDKEY_SECRET: every key,
// current and future, changes at once.
import { randomBytes, createHash } from 'node:crypto';
import { gate, weekIndex, describeWeek } from '../netlify/functions/_lib/sendkey.mts';

const [cmd, ...rest] = process.argv.slice(2);
const argOf = (f, d) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : d; };

function fmt(ms, offsetMs) {
  const d = new Date(ms + offsetMs);
  const sign = offsetMs >= 0 ? '+' : '-';
  const h = String(Math.abs(offsetMs) / 3_600_000).padStart(2, '0');
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} ${sign}${h}:00`;
}

if (cmd === 'secret') {
  console.log(randomBytes(32).toString('base64url'));
  console.error('\nSet it as TRX_SENDKEY_SECRET in Netlify → Site configuration → Environment variables');
  console.error('(scope: Functions; mark it secret). Setting it turns the send-key gate ON.');
} else if (cmd === 'grant') {
  const name = (rest[0] || '').trim();
  if (!/^[A-Za-z0-9._@-]{1,40}$/.test(name)) {
    console.error('usage: npm run sendkey -- grant <name>   (letters, digits, . _ @ -; max 40)');
    process.exit(2);
  }
  const token = randomBytes(32).toString('base64url');
  const pair = `${name}:${createHash('sha256').update(token).digest('hex')}`;
  console.log(`token for ${name} (give this to them; it is shown once):\n\n  ${token}\n`);
  console.log(`append to TRX_SENDKEY_VIEWERS (comma-separated):\n\n  ${pair}\n`);
  const cur = process.env.TRX_SENDKEY_VIEWERS;
  if (cur) console.log(`new value:\n\n  ${cur.replace(/,\s*$/, '')},${pair}\n`);
  console.log('They read the key at /key/ on the transfer site, or GET /api/sendkey with');
  console.log('"Authorization: Bearer <token>".');
} else if (cmd === 'keys') {
  const g = gate();
  if (g.on !== true) {
    console.error(g.on === false ? 'TRX_SENDKEY_SECRET is not set in this shell.' : 'TRX_SENDKEY_SECRET is too short (32 bytes minimum).');
    process.exit(2);
  }
  const weeks = Math.max(1, Math.min(52, Number(argOf('--weeks', 4)) || 4));
  const idx = weekIndex(Date.now(), g.offsetMs);
  for (let i = 0; i <= weeks; i++) {
    const w = describeWeek(g, idx + i);
    const label = i === 0 ? 'this week' : i === 1 ? 'next week' : `+${i} weeks`;
    console.log(`${label.padEnd(10)} ${w.keyDisplay}   ${fmt(w.validFrom, g.offsetMs)}  →  ${fmt(w.validUntil, g.offsetMs)}`);
  }
} else {
  console.error('usage: npm run sendkey -- secret | grant <name> | keys [--weeks N]');
  process.exit(2);
}
