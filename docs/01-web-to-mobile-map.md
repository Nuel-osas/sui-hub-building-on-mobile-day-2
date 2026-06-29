# Web → Mobile Map · Porting Tideform to a Phone

> Companion to [`00-architecture-source-of-truth.md`](./00-architecture-source-of-truth.md).
> Doc 00 holds the **facts** (IDs, endpoints, Move targets, type shapes). This doc holds
> the **map**: for every file in the Tideform web app, what is its mobile equivalent, what
> physically moves onto the device, what stays on the backend, and *why* the line falls
> where it does.
>
> Audience: you built a zkLogin app on Day 1. Today you are not learning a new chain — you
> are learning that **a mobile dApp is mostly a re-skin of the same client code**, plus one
> hard new idea: there is no wallet extension on a phone, so signing moves behind an HTTP
> call.

---

## 0. The one-sentence version

The web app is split into **on-device logic** (reads, schema, PTB construction) and
**server-held secrets** (the custodial key, the gas sponsor, the Walrus sponsor key). On
mobile you **re-implement the on-device half natively** and **call the server half over
HTTP** — the same routes the website already calls. You rebuild `lib/`, you do *not*
rebuild `/api/*`.

```
                          ┌─────────────────────── THE DEVICE ───────────────────────┐
  Tideform web `lib/`  →  │  Expo lib/  (TS)        Swift Lib/  (Swift)               │
                          │  suiClient · indexer · walrus(reads) · move · schema      │
                          └───────────────────────────┬──────────────────────────────┘
                                                       │ HTTPS (cookie-authed)
                          ┌────────────────────────────▼──────────────────────────────┐
  Next.js `/api/*`     →  │  UNCHANGED. Called, not rebuilt.                            │
  (stays server-side)     │  /api/auth/* · /api/wallet/* · /api/walrus/upload          │
                          │  holds: custodial key, gas sponsor, Walrus sponsor key     │
                          └────────────────────────────────────────────────────────────┘
```

---

## 1. The master map (every web piece → mobile equivalent)

| Web file (Tideform / Zentos) | What it does | Mobile equivalent | Where it runs | Rebuild or call? |
|---|---|---|---|---|
| `web/src/lib/env.ts` (config) | reads `NEXT_PUBLIC_*` IDs/URLs | `env` (Expo `lib/env.ts`, Swift `Lib/Env.swift`) | **device** | **Rebuild** — same keys, native config source |
| `web/src/lib/sui.ts` | constructs a `SuiClient` on the right fullnode | `suiClient` | **device** | **Rebuild** — identical `@mysten/sui` client in Expo; native JSON-RPC in Swift |
| `web/src/lib/indexer.ts` | `queryEvents` + `multiGetObjects`, parse Move structs | `listFormsForOwner`, `fetchForm`, `listSubmissions` | **device** | **Rebuild** — pure reads, no secrets |
| `web/src/lib/walrus.ts` (reads) | `GET {aggregator}/v1/blobs/{id}` | `readBlob`, `readJson`, `blobUrl` | **device** | **Rebuild** — public aggregator, no auth |
| `web/src/lib/walrus.ts` (writes) | POST multipart to `/api/walrus/upload` | `uploadBlob`, `uploadJson` | **device builds request, backend does the sponsored write** | **Call** the route; rebuild the thin client wrapper |
| `web/src/lib/move.ts` | builds PTBs (`tx.moveCall(...)`) | `txCreateForm`, `txSubmit`, `txSetFormStatus`, `txSubmissionStatus`, `txSubmissionPriority`, `txAttachNotes`, `txAddTag` | **device** | **Rebuild** — PTB construction has no secret; the *signing* of it does |
| `web/src/lib/schema.ts` | `FormSchema` / `Submission` / `FieldValue` types + helpers | `FieldType`, `Field`, `FormSchema`, `Submission`, `FieldValue` | **device** | **Rebuild** — pure data shapes; port the types verbatim |
| `web/src/lib/signer.ts` (Zentos, custodial) | `signAndExecuteCustodial(tx, addr)` → POST `/api/wallet/sign` | `signAndExecuteCustodial`, `custodialSignMessage`, `exportKey`, plus `signInWithGoogle`, `getMe`, `signOut` — the `ZentosClient` in `lib/api.ts` | **device builds kind-bytes, backend signs** | **Rebuild the client wrapper; CALL the route** |
| `web/src/lib/seal.ts` (encrypt/decrypt helpers) | Seal envelope encrypt + admin decrypt via SessionKey | Expo: best-effort with crypto polyfills. Swift: **documented backend-delegated boundary** | encrypt on device (Expo); decrypt needs `/api/wallet/sign-message` for the SessionKey | **Rebuild (Expo, best-effort) / boundary (Swift)** — see §6 |
| `web/src/app/api/auth/google/route.ts` | mints/loads custodial key, sets session cookie | — | **backend** | **CALL** — never ported to device |
| `web/src/app/api/auth/me`, `.../logout` | session read / clear | — | **backend** | **CALL** |
| `web/src/app/api/wallet/sign/route.ts` | decrypts key, sponsors gas, dual-signs, executes | — | **backend** | **CALL** — this is the whole reason the model exists |
| `web/src/app/api/wallet/sign-message/route.ts` | custodial personal-message signature | — | **backend** | **CALL** |
| `web/src/app/api/wallet/export/route.ts` | Bech32 key export (escape hatch) | — | **backend** | **CALL** |
| `web/src/app/api/walrus/upload/route.ts` | forwards to Krilly sponsor with the secret API key | — | **backend** | **CALL** |
| `web/src/app/**` (React pages, components) | the UI | Expo Router screens / SwiftUI views | **device** | **Rebuild** in the native UI framework (out of scope for these docs) |

> Read this table as a contract: anything marked **Rebuild** is a function you will write in
> both `lib/` (Expo) and `Lib/` (Swift) with the **same name** so the class can diff the two
> stacks line-for-line (doc 00 §10). Anything marked **Call** is an HTTP endpoint you talk to
> — it is already deployed at `backendBaseUrl` (defaults to `https://tidalform.xyz`).

---

## 2. The dividing line, stated precisely

There is exactly **one** question that decides whether a piece of web code becomes
device code or stays a backend call:

> **Does this operation require a secret that the user must never hold?**

Three secrets live on the backend and only the backend:

1. **The custodial private key** — minted from the Google `sub`, AES-256-GCM encrypted in
   Postgres. Decrypted in-memory only to sign. (doc 00 §6.1)
2. **The gas sponsor wallet** — the account that owns gas and pays for every transaction so
   the user spends 0 SUI. (doc 00 §6.2)
3. **The Walrus sponsor API key** — `WALRUS_SPONSOR_API_KEY`, the bearer token for the Krilly
   sponsor that makes uploads free. (doc 00 §5)

Everything that touches one of those three stays a server call. **Everything else moves to
the device**, because everything else is either a public read or pure local computation that
leaks nothing.

| If the web code… | …then on mobile it is | Because |
|---|---|---|
| reads a public endpoint (fullnode RPC, Walrus aggregator) | **on-device** | no auth, no secret, lower latency, works offline-ish |
| computes a value locally (build a PTB, encode a blob ID, validate a schema) | **on-device** | deterministic, secret-free; the *result* gets signed elsewhere |
| needs the custodial key, the gas sponsor, or the Walrus key | **a backend call** | the secret must never reach a phone you don't control |

---

## 3. What moves to the device (and why it's safe)

### 3.1 Reads — `suiClient`, `indexer`, `walrus` (read side)

All three flows that begin with "find data" run entirely on the phone:

- **My forms** — `queryEvents({ MoveEventType: ORIGINAL_PKG::events::FormCreated })` →
  filter `parsedJson.owner == myAddress` → `multiGetObjects` → fetch each `schema_blob_id`
  from the Walrus aggregator. (doc 00 §9.B)
- **View a form** — read the `Form` object + its schema blob, render fields by type.
- **Admin inbox** — `queryEvents(SubmissionReceived)` filtered by `form_id` →
  `multiGetObjects` → fetch payload blobs from Walrus.

These hit only **public endpoints**: the Sui fullnode for `network`, and the mainnet/testnet
Walrus aggregator (doc 00 §5). No cookie, no signature, no sponsor. That is why doc 00 §12
says plainly: *"Reads need no backend."* Putting reads on-device is not just allowed, it is
*better* — fewer hops, the backend never becomes a read bottleneck, and the app keeps
working for browsing even if your backend is down.

> **Gotcha carried over from doc 00 §12:** blob IDs are stored on-chain as ASCII
> `vector<u8>` (`TextEncoder().encode(blobId)`). On read you get a `number[]`; decode it with
> **UTF-8** (`TextDecoder` / Swift `String(decoding:as:)`). **Never base64-decode a blob ID.**

### 3.2 PTB construction — `move.ts` → `tx*` builders

The web `move.ts` builds a `Transaction` with `tx.moveCall(...)`. **Building a PTB is pure,
secret-free computation** — you are assembling bytes that describe an intent. The signature
is what authorizes it, and that happens elsewhere. So the `tx*` builders move to the device
unchanged. The exact encodings are pinned in doc 00 §4 — including the load-bearing detail
that `schema_blob_id` / `blob_id` are `tx.pure.vector("u8", new TextEncoder().encode(id))`,
**not** a base64 decode.

A device-side builder looks like (Expo):

```ts
// lib/move.ts  (mobile) — mirrors web/src/lib/move.ts
import { Transaction } from "@mysten/sui/transactions";
import { env } from "./env";

export function txSubmit(formId: string, blobId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${env.packageId}::submission::submit`,
    arguments: [
      tx.object(formId),
      tx.pure.vector("u8", new TextEncoder().encode(blobId)), // ASCII bytes, per doc 00 §4
      tx.object("0x6"),                                        // Clock, shared, always
    ],
  });
  return tx;
}
```

The returned `tx` is handed to `signAndExecuteCustodial` (§5), which is the *only* step that
crosses to the backend.

### 3.3 Schema + types — `schema.ts`

`FormSchema`, `Submission`, `FieldValue`, the 14 field types (doc 00 §8) are **data shapes
with zero runtime secrets**. Port them verbatim into `lib/schema.ts` (Expo) and
`Lib/Schema.swift` (Swift). The class should be able to lay the web `schema.ts` next to the
Expo `schema.ts` and see the same fields. This is the cleanest "it's the same app" moment in
the workshop — use it.

---

## 4. What stays on the backend (and why it must)

The Next.js `/api/*` routes are **not** rebuilt for mobile. They are deployed once and called
by the website *and* both mobile clients. Three reasons they cannot move to the device:

1. **Secret custody.** A phone in a user's hand is not a trusted server. The custodial key,
   the gas sponsor key, and the Walrus bearer token would all be extractable from a shipped
   app binary. Keeping them server-side is the entire security model.
2. **Gasless + popup-less UX (the headline).** The user pays 0 SUI and sees 0 popups
   (doc 00 §6.2) precisely *because* the server owns the gas sponsor and dual-signs. You
   cannot sponsor your own gas from a device that holds no sponsor key.
3. **The Move-target allowlist.** `/api/wallet/sign` only honors Tideform/Zentos package
   targets so the sponsor can't be drained by arbitrary PTBs (doc 00 §6.2). That policy is a
   server-side guardrail; a device-side signer would have no such gate.

So mobile **calls** these and treats them as a stable contract. Their exact request/response
shapes are the subject of [`02-zentos-and-sponsorship.md`](./02-zentos-and-sponsorship.md);
here we only assert *that* they stay put and *why*.

---

## 5. The seam: `signer.ts` → the zentos client

This is the single most important line in the whole port, so it gets its own section.

On the web, `web/src/lib/signer.ts` (doc 00 §6.3) does three things:
1. `tx.setSender(custodialAddress)`
2. `tx.build({ onlyTransactionKind: true })` → base64 "kind bytes"
3. `fetch("/api/wallet/sign", { body: { txKindBytes } })` → `{ digest, sponsorAddress, senderAddress }`

Steps 1 and 2 are **device-side** (pure PTB work). Step 3 is the **backend call**. The
mobile `signAndExecuteCustodial` (a method on the `ZentosClient` in `lib/api.ts`) mirrors this
exactly — the *only* mobile-specific change is that the call goes through `cookieFetch`
(doc 02 §6), which attaches the stored session cookie that a browser would send automatically.

```ts
// lib/api.ts (mobile) — ZentosClient method, mirrors web/src/lib/signer.ts
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { cookieFetch } from "./cookies";  // attaches the stored Cookie header (doc 02 §6)
import { suiClient } from "./sui";
import { env } from "./env";

async signAndExecuteCustodial(tx: Transaction, address: string): Promise<SignResult> {
  tx.setSender(address);                                                   // device
  const kindBytes = toBase64(
    await tx.build({ client: suiClient, onlyTransactionKind: true })       // device
  );
  const res = await cookieFetch(`${env.backendBaseUrl}/api/wallet/sign`, { // backend
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txKindBytes: kindBytes }),
  });
  if (!res.ok) throw new Error(`sign failed: ${res.status}`);
  return res.json(); // { digest, sponsorAddress, senderAddress }
}
```

Note what the device sends: only `txKindBytes` — the *intent*, never a key. The server adds
the sender signature (custodial key) **and** the sponsor signature (gas) and executes. That
asymmetry — device proposes, server authorizes and pays — is the whole custodial+sponsored
model in one function.

---

## 6. The one genuinely awkward port: Seal

Seal is the exception that proves the rule, and doc 00 §7 is blunt about it. Private-field
**encryption on submit** is device-side computation in principle, and in **Expo** it can run
with crypto polyfills (best-effort — document it as such). But:

- **Decryption** (admin inbox) needs a Seal `SessionKey` signed by the user's key. On the web
  that's a wallet popup; on mobile it becomes `/api/wallet/sign-message` (doc 00 §6.2, §7) —
  i.e. the SessionKey signature is a **backend call**, even though the decrypt math runs
  locally.
- **Swift has no Seal SDK.** So in the Swift stack, private-field decryption is a
  **clearly-labeled, documented backend-delegated boundary** (or out of v1 teaching scope).
  **Public fields work fully on both stacks.** Never present placeholder mode as real
  encryption.

This is the only place where "rebuild on device" partially fails, and it fails *honestly*:
the doc names the boundary instead of faking it.

---

## 7. Walkthrough: the Submit flow, mapped piece by piece

Tie it together with the marquee flow (doc 00 §9.D). Each step is labeled with its origin web
file and its runtime home:

| Step | Web origin | Mobile function | Runs on |
|---|---|---|---|
| 1. Assemble `Submission` JSON (encrypt private fields if in scope) | `schema.ts` (+`seal.ts`) | build `Submission`, `FieldValue[]` | **device** |
| 2. Upload payload to Walrus (sponsored) | `walrus.ts` write → `/api/walrus/upload` | `uploadJson(submission, { owner })` | **device → backend** (backend holds the key) |
| 3. Get `blob_id` back | `/api/walrus/upload` response | `{ blob_id }` | backend returns; **device keeps it** |
| 4. Build `submission::submit` PTB | `move.ts` | `txSubmit(formId, blobId)` | **device** |
| 5. `tx.build({ onlyTransactionKind: true })` | `signer.ts` | inside `signAndExecuteCustodial` | **device** |
| 6. Sign + sponsor + execute | `signer.ts` → `/api/wallet/sign` | `signAndExecuteCustodial(tx, addr)` | **device → backend** |
| 7. Show tx digest + Walrus receipt | UI | screen | **device** |

Four of seven steps are pure device code you ported from `lib/`. The two backend calls are
exactly the two that need a secret (the Walrus key, the custodial+sponsor keys). Step 6
returns no popup and costs the user no gas — **surface that in the demo** (doc 00 §12).

---

## 8. Mental model to leave the room with

- A mobile dApp here = **`lib/` rebuilt natively + `/api/*` called over HTTP.**
- The split is mechanical: **secret-free → device; secret-bearing → backend.**
- You did not learn a new chain today. You learned where the trust boundary sits and how to
  keep a phone on the safe side of it while still getting one-tap, gasless, popup-less UX.
- The single new primitive vs. Day 1's on-device zkLogin is the **`/api/wallet/sign` seam** —
  device builds the intent, server holds the key and the gas. Day 1 kept the key on the
  device; Day 2 moves it behind a call. That trade-off is the subject of
  [`03-auth-models-day1-vs-day2.md`](./03-auth-models-day1-vs-day2.md).
