# CLAUDE.md

Guidance for Claude Code working in **DraconDex-TRX**.

## What this is

The **DDX Transfer** service: a Netlify site plus seven functions that hold an
encrypted DraconDex Nexus for up to thirty minutes while it moves from one
device to another. It holds no application code and knows nothing about
DraconDex's schema — to this repo a transfer is an opaque blob, a hashed PIN,
and two hashed bearer tokens.

If you are here to change how a vault is serialized, **you are in the wrong
repo**: that is `serializeVault`/`applySnapshot` in DraconDex-EXE and its Dart
port in DraconDex-APK. This repo never looks inside the payload.

## Where it sits in the chain

TRX is the eighth repo in the chain and is **upstream of EXE and APK** —
change the API here and both clients must follow. It is downstream of APP only
for the mirrored Claude tooling. `.claude/` here is **generated output**: edit
it in `DraconDex-APP/.claude/` and run `npm run mirror --prefix ../DraconDex-APP`.

## Hard rules

1. **The wire format is a three-way contract.** `public/assets/js/ddx-crypto.js`
   is the source of truth; `electron/src/db/transfer.js` (EXE) and
   `lib/data/services/ddx_transfer_service.dart` (APK) must agree with it byte
   for byte. A mismatch does not throw — it delivers a vault that imports as
   nonsense. Change one, change all three, and update `test/crypto.test.mjs`
   in the same breath.

2. **Never make this service able to read more than it already can.** The key
   is generated on the sending device and reaches this service in exactly one
   form — `pinWrap`, sealed under the PIN, and only when the sender allowed
   the typed-code flow. Anything that widens that (logging a fragment,
   accepting a key in a request body, storing a decrypted manifest) breaks the
   promise the README makes in a table.

3. **Every limit lives in `_lib/codes.mts`.** `maxChunkBytes` is handed to
   clients by `/api/create` rather than hardcoded on three platforms, because
   it is Netlify's number, not ours.

4. **`bad_code` covers both "no such code" and "wrong PIN".** Telling them
   apart turns the 8-character code into an oracle. Do not add a friendlier
   error here.

5. **Purge lists the prefix; it never counts to `chunkCount`.** An upload that
   never committed has `chunkCount: 0` and real chunks on disk — counting
   would leak the payload past its own expiry.

## Running it

```bash
npm install
npm test          # crypto contract + the whole protocol, no network
npm run dev       # netlify dev, sandboxed local blob store
```

`npm test` needs Node 22: it runs the real `.mts` handlers through
`--experimental-strip-types` with the blob store swapped out by
`--experimental-test-module-mocks`.
