# Zentos & Sponsorship · The Custodial + Sponsored Model From a Phone

> Companion to [`00-architecture-source-of-truth.md`](./00-architecture-source-of-truth.md)
> (the facts) and [`01-web-to-mobile-map.md`](./01-web-to-mobile-map.md) (the port).
> This doc is the **end-to-end mechanics** of how a phone with no wallet extension and no SUI
> still gets one-tap, gasless, popup-less transactions — through Zentos.
>
> Everything here is a precise restatement of doc 00 §6–§7 with the request/response shapes
> spelled out and the mobile-only gotchas (cookies!) made explicit. **No IDs, routes, or
> shapes are invented** — if something isn't pinned in doc 00 it is marked `// VERIFY`.

---

## 0. What Zentos is, in one paragraph

Zentos is a **custodial Google → Sui wallet for apps**. The same Google account always maps
to the same Sui address (doc 00 §6.1). The private key is minted server-side, AES-256-GCM
encrypted, and stored in Postgres keyed by the Google `sub`. The app never sees the key. When
the app wants to transact, it builds the *intent* and POSTs it; the server decrypts the key
in memory, signs as the user, **also** signs as a gas sponsor, executes, and returns a
digest. The user spends **0 SUI** and sees **0 popups**. That headline UX is the entire point
of the model — preserve and surface it (doc 00 §6.2, §12).

The web app already talks to Zentos over HTTP. **Mobile reuses the exact same endpoints**
(doc 00 §6). You are not rebuilding auth, signing, or gas — you are writing a native client
over routes that already exist at `backendBaseUrl` (defaults to `https://tidalform.xyz`,
env-overridable; doc 00 §10).

---

## 1. The four moving parts

```
   PHONE (no key, no SUI, no wallet ext.)        ZENTOS BACKEND (holds all secrets)
   ─────────────────────────────────────         ─────────────────────────────────────
   1. Google native sign-in  ── idToken ───▶   POST /api/auth/google
                              ◀── cookie ────   mint/load custodial key, set session
                                                 │  key:    AES-GCM in Postgres (by sub)
   2. build PTB intent       ── kindBytes ──▶   POST /api/wallet/sign
                              ◀── digest ─────   decrypt key, set sponsor as gas owner,
                                                 │  dual-sign (sender + sponsor), execute
   3. Seal SessionKey        ── message ────▶   POST /api/wallet/sign-message
                              ◀── signature ──   personal-message sig with custodial key
   4. file bytes             ── multipart ──▶   POST /api/walrus/upload
                              ◀── blob_id ────   forward to Krilly w/ secret bearer key
```

Three secrets, all server-only (doc 00 §2 of doc 01): the **custodial key**, the **gas
sponsor wallet**, the **Walrus sponsor API key**. The phone holds none of them. The only
thing the phone persists is the **session cookie** (§6).

---

## 2. Step 1 — Sign in: Google ID token → session cookie

### Native Google sign-in yields an ID token

There is no wallet extension on a phone (doc 00 §12), so identity starts from Google:

- **Expo** → `expo-auth-session` (or `@react-native-google-signin`), `responseType=id_token`,
  scopes `openid email`. Configure with `env.googleClientId`.
- **Swift** → `GoogleSignIn-iOS`.

Both yield a **Google ID-token JWT**. That JWT is the only credential you POST.

### The exchange (doc 00 §6.1)

```
POST {backendBaseUrl}/api/auth/google
Content-Type: application/json

  { "idToken": "<google id_token jwt>" }

→ 200
  {
    "address": "0x…",     // the user's deterministic Sui address
    "email":   "…",
    "name":    "…",
    "picture": "https://…",
    "isNew":   false       // true on first-ever sign-in (key just minted)
  }
  Set-Cookie: <HMAC session cookie; HttpOnly>
```

First sign-in mints an `Ed25519Keypair`, AES-256-GCM encrypts the secret, stores it in
Postgres keyed by the Google `sub`. **Same Google account → same Sui address forever**
(doc 00 §6.1). On every later sign-in the same row is loaded — the address is stable.

### Session restore on launch

```
GET {backendBaseUrl}/api/auth/me          (cookie)
→ 200 { address, email, name, picture, isExported }   or   401
```

On app launch, send the stored cookie to `/api/auth/me`. 200 → restore the session and skip
the Google screen; 401 → show sign-in (doc 00 §6.1, §9.A).

### Sign out

```
POST {backendBaseUrl}/api/auth/logout     → clears cookie
```

Also delete the locally stored cookie (§6).

---

## 3. Step 2 — Sign + sponsor: PTB kind bytes → dual signatures

This is the gasless, popup-less core. The phone builds an *intent* and the server turns it
into an executed, sponsored transaction.

### What the phone sends

The client builds a PTB (doc 01 §3.2, exact encodings in doc 00 §4), sets the sender, and
serializes **only the transaction kind** — not a full signed transaction:

```ts
tx.setSender(custodialAddress);
const txKindBytes = toBase64(
  await tx.build({ client: suiClient, onlyTransactionKind: true })
);
```

`onlyTransactionKind: true` is load-bearing: it omits gas/sender resolution so the **server**
can attach the sponsor as gas owner. Then (doc 00 §6.2–6.3):

```
POST {backendBaseUrl}/api/wallet/sign      (cookie)
Content-Type: application/json

  { "txKindBytes": "<base64 of tx.build({ onlyTransactionKind: true })>" }

→ 200
  {
    "digest":        "…",   // executed transaction digest
    "sponsorAddress":"0x…", // the gas sponsor that paid
    "senderAddress": "0x…"  // the user's custodial address
  }
```

### What the server does (doc 00 §6.2)

1. Decrypts the user's key **in memory** (never written back out).
2. Sets the **sponsor wallet as the gas owner**.
3. Signs **twice** — once as **sender** (the user's custodial key), once as **sponsor** (the
   gas key).
4. Executes. Returns the digest.

> **Result: the user pays 0 SUI and sees 0 popups.** This is the headline. In the demo,
> submit a form and point out there was no gas prompt and no SUI in the wallet (doc 00 §12).

### The guardrail: a Move-target allowlist

`/api/wallet/sign` enforces a **Move-target allowlist** — only Tideform/Zentos package
targets are honored — so a leaked cookie can't drain the sponsor with arbitrary PTBs
(doc 00 §6.2). This is *why* this step must stay server-side (doc 01 §4): the policy gate
lives next to the key.

### The mobile signer (mirrors web `signer.ts`, doc 00 §6.3)

```ts
// lib/api.ts (mobile) — ZentosClient method
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { cookieFetch } from "./cookies";
import { suiClient } from "./sui";
import { env } from "./env";

async signAndExecuteCustodial(tx: Transaction, address: string): Promise<SignResult> {
  tx.setSender(address);
  const kindBytes = toBase64(
    await tx.build({ client: suiClient, onlyTransactionKind: true })
  );
  const res = await cookieFetch(`${env.backendBaseUrl}/api/wallet/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txKindBytes: kindBytes }),
  });
  if (!res.ok) throw new Error(`sign failed: ${res.status} ${await res.text()}`);
  return res.json(); // { digest, sponsorAddress, senderAddress }
}
```

The **only** difference from the web version is `cookieFetch` (§6) attaching the session
cookie manually. The web browser does that automatically; a phone does not.

---

## 4. Step 3 — Sign message: the Seal SessionKey

Seal's admin-inbox decryption needs a `SessionKey` proving the user owns their address before
the key servers release decryption shares (doc 00 §7). On the web this is a wallet-popup
`signPersonalMessage`. On mobile there is no wallet, so it becomes a backend call to the
custodial signer (doc 00 §6.2):

```
POST {backendBaseUrl}/api/wallet/sign-message   (cookie)
Content-Type: application/json

  { "message": "<base64 of the bytes to sign>" }

→ 200
  { "signature": "…", "address": "0x…" }
```

Flow (doc 00 §7): create a Seal `SessionKey` with the user's `address` + `packageId`, take
the bytes it wants signed, base64 them into `message`, POST, and feed the returned
`signature` back into the SessionKey. Then build a PTB calling
`acl::seal_approve(idBytes, form)` (Tideform's **form-bound** ACL — doc 00 §3.4),
`tx.build({ onlyTransactionKind: true })`, and `client.decrypt({ data, sessionKey, txBytes })`.

```ts
// lib/api.ts (mobile) — ZentosClient method
async custodialSignMessage(message: Uint8Array): Promise<SignMessageResult> {
  const res = await cookieFetch(`${env.backendBaseUrl}/api/wallet/sign-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: toBase64(message) }),
  });
  if (!res.ok) throw new Error(`sign-message failed: ${res.status}`);
  return res.json(); // { signature, address }
}
```

> **Stack reality (doc 00 §7):** Expo can run `@mysten/seal` with crypto polyfills
> (best-effort — document it). Swift has **no Seal SDK**, so private-field decryption is a
> documented backend-delegated boundary or out of v1 scope. **Public fields work fully on
> both stacks. Never claim placeholder mode is real encryption.**
> The mainnet Seal key server (free, public, threshold 1) is pinned in doc 00 §7.

---

## 5. Step 4 — Sponsored Walrus upload (zero WAL/SUI)

Writes go through the app's own backend so the user spends nothing (doc 00 §5). The phone
POSTs **multipart/form-data**; the backend forwards to the Krilly sponsor with a server-only
bearer key that never reaches the client.

```
POST {backendBaseUrl}/api/walrus/upload     (cookie)
Content-Type: multipart/form-data

  file            = <raw bytes>
  creator_address = 0x…           // the user's Sui address
  epochs          = 5
  deletable       = true

→ 200
  {
    "blob_id":           "…",     // ← THIS is what you store on-chain
    "sponsored_blob_id": "…",
    "tx_digest":         "…",
    "end_epoch":         123,     // optional
    "wal_cost":          456      // optional
  }
```

The backend adds `Authorization: Bearer <WALRUS_SPONSOR_API_KEY>` and forwards to the Krilly
sponsor endpoint (pinned in doc 00 §5). **`blob_id` is the value you encode and pass to Move**
— remember it's stored on-chain as **ASCII `vector<u8>`** via `TextEncoder().encode(blob_id)`,
not a base64 decode (doc 00 §4, §12).

```ts
// lib/walrus.ts (mobile, write side)
import { cookieFetch } from "./cookies";
import { env } from "./env";

export async function uploadBlob(
  bytes: Uint8Array,
  opts: { owner: string; epochs?: number; deletable?: boolean; mime?: string; name?: string },
) {
  const form = new FormData();
  // field names match doc 00 §5 exactly.
  const blob = new Blob([bytes], { type: opts.mime ?? "application/octet-stream" });
  form.append("file", blob as any, opts.name ?? "submission.json");
  form.append("creator_address", opts.owner);
  form.append("epochs", String(opts.epochs ?? 5));
  form.append("deletable", String(opts.deletable ?? true));
  // Do NOT set Content-Type — the platform sets the multipart boundary itself.
  const res = await cookieFetch(`${env.backendBaseUrl}/api/walrus/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`walrus upload failed: ${res.status}`);
  // wire shape → the shipped lib normalizes snake_case to { blobId, sponsoredBlobId, ... }
  return res.json(); // { blob_id, sponsored_blob_id, tx_digest, end_epoch?, wal_cost? }
}
```

Reads, by contrast, need **no backend** — `GET {walrusAggregator}/v1/blobs/{blob_id}` straight
from the device (doc 00 §5, §12). Upload is sponsored; download is public.

---

## 6. THE mobile gotcha: cookies don't persist like a browser

This is the one thing that silently breaks every privileged call if you miss it (doc 00 §12).

**The problem.** The backend authenticates with an **HttpOnly HMAC session cookie** set by
`/api/auth/google`. A browser stores and re-sends that cookie automatically. **Expo `fetch`
does not.** If you ignore it, sign-in "works" (you get an address back) but the very next call
to `/api/wallet/sign` returns 401 because no cookie rode along.

**The fix (Expo).** Route **every** privileged call through one `cookieFetch` wrapper
(`lib/cookies.ts`) that (1) attaches the stored cookie and (2) captures any `Set-Cookie` from
the response into `expo-secure-store`. Because the wrapper captures on *every* response, the
`/api/auth/google` cookie is persisted with no extra step — and `/api/auth/me`, `/api/wallet/*`,
and `/api/walrus/upload` all send it back automatically.

```ts
// lib/cookies.ts (Expo) — the single wrapper every privileged call goes through
import * as SecureStore from "expo-secure-store";
const COOKIE_KEY = "tideform.session.cookie";

/** The stored `Cookie` header value (e.g. "zentos_session=…"), or null. */
export async function getCookieHeader(): Promise<string | null> {
  return (await SecureStore.getItemAsync(COOKIE_KEY)) || null;
}

/** Capture & persist any Set-Cookie from a backend response. */
export async function captureSetCookie(res: Response): Promise<void> {
  // GOTCHA: RN folds multiple Set-Cookie headers into ONE comma-joined string.
  // A naive split on "," breaks on `Expires=Wed, 21 Oct …` — use a set-cookie-aware
  // splitter, then keep each cookie's `name=value` (everything before the first `;`)
  // and merge by name into the stored header.
  const raw = res.headers.get("set-cookie");
  if (!raw) return;
  /* …split, take name=value of each, merge, then… */
  await SecureStore.setItemAsync(COOKIE_KEY, /* merged "a=1; b=2" */ raw.split(";")[0]);
}

/** fetch wrapper: attach the stored cookie, then capture the response's Set-Cookie. */
export async function cookieFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const cookie = await getCookieHeader();
  if (cookie) headers.set("Cookie", cookie);
  // We manage cookies manually; tell the platform not to also try.
  const res = await fetch(input, { ...init, headers, credentials: "omit" });
  await captureSetCookie(res);
  return res;
}

/** Forget the session on sign-out. */
export async function clearCookie(): Promise<void> {
  await SecureStore.deleteItemAsync(COOKIE_KEY);
}
```

> The shipped `lib/cookies.ts` includes the full `splitCookiesString` (the well-known
> `set-cookie-parser` splitter) and merges multiple cookies by name; the block above is the
> teaching skeleton. `lib/api.ts` and `lib/walrus.ts` both build on `cookieFetch`.

**The fix (Swift).** Use a shared `URLSession` backed by `HTTPCookieStorage` — it persists the
cookie automatically across requests (doc 00 §12). If you build requests manually, capture the
`Set-Cookie` header and re-attach it yourself.

```swift
// Lib/Session.swift (Swift) — sketch
let config = URLSessionConfiguration.default
config.httpCookieStorage = HTTPCookieStorage.shared   // persists the session cookie
config.httpCookieAcceptPolicy = .always
let session = URLSession(configuration: config)        // reuse this for ALL Zentos calls
```

> Store **only the cookie** on the device — never a key. The cookie is a bearer credential, so
> keep it in `expo-secure-store` / Keychain, clear it on `/api/auth/logout`, and treat a 401
> as "re-run sign-in."

---

## 7. End-to-end: the gasless Submit, fully wired

Putting all four steps together (doc 00 §9.D), with each backend call labeled:

```
1. Sign in once   → POST /api/auth/google     → store cookie (§2, §6)
2. Build Submission JSON (encrypt private fields if in scope)            [device]
3. uploadJson(submission, { owner })  → POST /api/walrus/upload  → blob_id   (§5)
4. txSubmit(formId, blob_id)          → build PTB                        [device, doc 00 §4]
5. signAndExecuteCustodial(tx, addr)  → POST /api/wallet/sign    → digest    (§3)
6. Show tx digest + Walrus receipt                                       [device]
```

Two backend calls (steps 3 and 5), each guarding one secret (the Walrus key; the
custodial + sponsor keys). Step 5 returns **no popup** and costs the user **no gas** — that is
the moment to call out in the room. Everything else is on-device code ported from `lib/`
(doc 01).

---

## 8. Checklist to leave with

- [ ] Sign-in posts a **Google ID token** to `/api/auth/google`; you **capture and persist the
      cookie** (Expo SecureStore / Swift HTTPCookieStorage).
- [ ] Every privileged call (`/api/wallet/*`, `/api/walrus/upload`, `/api/auth/me`) carries the
      cookie; a 401 means "cookie missing/expired → re-auth."
- [ ] You send **only `txKindBytes`** to `/api/wallet/sign` — never a key. The server
      dual-signs (sender + sponsor) and pays gas.
- [ ] `blob_id` from `/api/walrus/upload` is stored on-chain as **ASCII `vector<u8>`**, not
      base64.
- [ ] Seal SessionKey signatures come from `/api/wallet/sign-message`; Swift treats decryption
      as a documented boundary; **public fields work on both stacks**.
- [ ] The demo **shows** the gasless, popup-less submit explicitly.
- [ ] `backendBaseUrl` defaults to `https://tidalform.xyz` and is env-overridable for a
      self-hosted Zentos or localhost.
