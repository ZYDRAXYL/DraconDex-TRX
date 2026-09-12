<h1 align="center">DraconDex-TRX</h1>

<p align="center">
  <strong>DDX Transfer</strong> — hand a DraconDex Nexus to another device.
  No account, no setup, nothing kept.
</p>

<p align="center">
  <em>ส่ง Nexus จากเครื่องหนึ่งไปอีกเครื่องหนึ่ง — ไม่ต้องล็อกอิน
  ไม่ต้องตั้งค่าอะไร และไม่มีข้อมูลค้างอยู่บนเซิร์ฟเวอร์</em>
</p>

---

## What this is

[DraconDex](https://github.com/ZYDRAXYL/DraconDex-APP) already has two ways to
move a world between machines, and neither one fits "send this to my laptop,
now":

- **Export a file** and find your own way to carry it — USB, chat, email.
- **Cloud Sync** ([`docs/SYNC.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/SYNC.md)),
  which works, but first asks you to create your own Supabase project and sign
  in with Google.

This is the third way. The sending app produces a code and a PIN; the
receiving app takes them and pulls the vault down. This service is the
middleman for the thirty minutes in between, and it is deliberately the least
trusted part of the system.

```
Device A                      DraconDex Transfer                    Device B
────────                      ──────────────────                    ────────
serialize the Nexus
gzip
encrypt  (key K, made here)
        │
        ├── ciphertext ──────► Netlify Blobs
        │                      code ABCD-EFGH
        │                      PIN  482-719
        │                      expires in 30 min
        │
        └── the code, the PIN and a QR ──────────────────────────────► scan / type
                                                                            │
                                      ◄── verify (code + PIN) ──────────────┤
                                      ─── sealed manifest ─────────────────►│
                                                                     open it locally
                                                                     "My World, 2.4 MB"
                                                                       [ Receive ]
                                      ◄── chunks ────────────────────────────┤
                                      ─── ciphertext ──────────────────────►│
                                                                     decrypt, gunzip,
                                                                     import as a new Nexus
                                      ◄── complete ─────────────────────────┤
                                   everything deleted
```

## It cannot read what you send (in the mode that says so)

The transfer key is generated on the sending device and is **never uploaded**.
It travels in the `#fragment` of the QR/link, which browsers do not put in the
request line or the `Referer` header.

The project name, size and timestamp are sealed under that same key, so this
service does not learn what anyone is sending — only that someone is.

There is exactly one hole in that, and it is a deliberate one:

| Mode | What the service holds | Who can read the payload |
|---|---|---|
| **QR / link only** | ciphertext | only the device that scans |
| **Typed code allowed** (default) | ciphertext **+ the key sealed under the PIN** | the service could, while the transfer is waiting |

Typing `ABCD-EFGH` and a PIN cannot work without the service being able to
give you back the key — so allowing it means allowing that. The sender chooses,
the sender's screen says which mode it is in, and turning the switch off makes
the QR the only way in. The PIN is six digits rather than four for this
reason: in that mode it is key material against an offline attacker, not just
a doorbell the rate limiter guards.

## What it keeps, and for how long

Nothing, past 30 minutes — and normally far less than that. A received
transfer is deleted the moment the receiver confirms it decrypted, code index
included, so the code goes back into circulation. An `@hourly` scheduled
function sweeps whatever nobody came back for.

There are no accounts, so there is nothing to tie a transfer to a person: a
transfer is an opaque blob, a hashed PIN and two hashed bearer tokens.

## Layout

```
netlify.toml                  publish dir, functions dir, CSP, the /t/* rewrite
netlify/functions/
  create.mts                  POST   /api/create           mint a code, PIN and upload token
  chunk.mts                   PUT    /api/chunk/:id/:n     upload  (upload token)
                              GET    /api/chunk/:id/:n     download (receipt token)
  commit.mts                  POST   /api/commit           seal it: manifest, chunk count, optional pinWrap
  session.mts                 GET    /api/status/:id       the sender's view
                              DELETE /api/cancel/:id       call it off
  verify.mts                  POST   /api/verify           code + PIN -> sealed manifest + receipt token
  complete.mts                POST   /api/complete         received; delete everything
  sweep.mts                   @hourly — expiry is not only checked on read
  _lib/store.mts              the blob store, key layout, and purge
  _lib/codes.mts              code/PIN/token generation, hashing, and every limit
  _lib/http.mts               CORS, JSON helpers, the error vocabulary
public/
  index.html                  Send / Receive
  t/index.html                where a scanned QR lands
  assets/js/ddx-crypto.js     THE WIRE FORMAT — see below
  assets/js/ddx-api.js        the protocol, client side
  assets/js/qrcode.js         vendored QR encoder (MIT, Kazuhiko Arase)
test/                         the crypto contract and the whole protocol
```

## The wire format lives in three places

`public/assets/js/ddx-crypto.js` is the source of truth, and two ports of it
have to agree with it byte for byte:

| Where | File |
|---|---|
| Browser | `public/assets/js/ddx-crypto.js` (here) |
| Electron | `electron/src/db/transfer.js` in **DraconDex-EXE** |
| Flutter | `lib/data/services/ddx_transfer_service.dart` in **DraconDex-APK** |

A mismatch does not throw — it lands a vault that imports as nonsense. Every
parameter is therefore stated explicitly rather than left to a library
default, and `test/crypto.test.mjs` pins all of them.

```
key        32 random bytes, made by the sender, never uploaded
payload    gzip(snapshot JSON) -> split -> AES-256-GCM per chunk
chunk      [12-byte IV][ciphertext || 16-byte tag]
manifest   AES-256-GCM over JSON, carried as { iv, ct } (base64)
pinWrap    AES-256-GCM over the key, under PBKDF2-SHA256(code + ":" + pin, salt, 600000)
```

Chunking is not an optimisation: Netlify's synchronous functions cap a request
body at around 6 MB, so `/api/create` tells the client what a chunk may be
(`maxChunkBytes`) rather than every client hardcoding a platform number.

## Running it

```bash
npm install
npm test          # the crypto contract + the protocol, no network needed
npm run dev       # netlify dev, with a sandboxed local blob store
```

## Where this sits in the project

TRX is the eighth repository in the DraconDex chain and is **upstream of EXE
and APK**: change the API here and both clients have to follow. It is
downstream of APP only for the mirrored Claude tooling. See
[`chain/chain.json`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/chain/chain.json).

Full documentation, in Thai, is
[`docs/TRANSFER.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/TRANSFER.md)
in the hub.

## Licence

Apache-2.0 — see [LICENSE](LICENSE).

> Note: DraconDex-APP and DraconDex-EXE ship MIT, and DraconDex-WEB ships
> Apache-2.0. This repo follows the licence chosen when it was created; worth
> settling the project-wide inconsistency separately rather than here.

The vendored QR encoder is MIT, © 2009 Kazuhiko Arase — see
`public/assets/js/qrcode.LICENSE`. Apache-2.0 and MIT are compatible for
redistribution, and that file keeps its own notice as its licence requires.
