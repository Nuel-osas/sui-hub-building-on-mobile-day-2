# Tideform → Mobile · Architecture Source of Truth

> This is the ground-truth reference for porting **Tideform** (live at tidalform.xyz)
> to mobile (Expo for iOS+Android, and native Swift for iOS). Every code-generating
> agent and every student should treat the facts in this file as authoritative.
> All IDs, endpoints, Move targets, and type shapes below were read directly from
> the production `walrus-feedback` workspace.

---

## 1. What Tideform is

A **Walrus-native feedback & form platform**. You spin up a form (bug report, survey,
application), share a public link, collect submissions stored on **Walrus**, and triage
them in a private admin dashboard. Form ownership + admin ACLs are **Sui Move objects**.
Private fields are encrypted with **Seal**.

The web app is **Next.js 16**. Its auth + wallet + gas layer is a separate reusable
package called **Zentos**.

### The two packages in play

| Package | Role | On-chain |
|---|---|---|
| **Tideform** | Forms, submissions, admin ACL, events | `tideform` Move package (mainnet) |
| **Zentos** | Custodial Google→Sui wallet, sponsored signing, Seal encrypt/decrypt helpers | `zentos_acl` Move package (Seal ACL) |

---

## 2. Live on-chain identifiers (Sui MAINNET)

```
tideform package (published-at) = 0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4
tideform original-id            = 0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4
upgrade-capability              = 0x6f7b55e74da2a6443fbe96d16ac2c9ae9988622b13dbacf14f8cb05fce6400d6
chain-id                        = 35834a8a (mainnet)
Clock object                    = 0x6   (shared, always)
```

The `original-id` is used for **event type queries** (event type-origin never changes
across upgrades). `published-at` (== same here, v1) is used for **moveCall targets**.

> ⚠️ For a workshop you may prefer **testnet**. Republish `tideform` + `zentos_acl`
> to testnet, set `NEXT_PUBLIC_SUI_NETWORK=testnet`, and swap the package IDs. The
> mobile clients read all IDs from env — nothing is hard-coded.

---

## 3. The Move package: `tideform`

Four modules: `form`, `submission`, `events`, `acl`. Source lives in
`walrus-feedback/move/sources/`.

### 3.1 `form` module

```move
public struct Form has key {
    id: UID,
    owner: address,
    admins: VecSet<address>,
    schema_blob_id: vector<u8>,   // ASCII bytes of the Walrus blob ID (a base64url string)
    created_at_ms: u64,
    updated_at_ms: u64,
    version: u64,
    status: u8,                   // 0 OPEN · 1 CLOSED · 2 ARCHIVED
    submissions_count: u64,
    require_wallet: bool,
    one_per_wallet: bool,
}
```

Entry/public functions you call from the client:

| Target | Args (in order) |
|---|---|
| `form::create` | `vector<u8> schema_blob_id`, `bool require_wallet`, `bool one_per_wallet`, `&Clock(0x6)` |
| `form::update_schema` | `&mut Form`, `vector<u8> new_schema_blob_id`, `&Clock` |
| `form::set_status` | `&mut Form`, `u8 status` |
| `form::add_admin` | `&mut Form`, `address admin` |
| `form::remove_admin` | `&mut Form`, `address admin` |

`form::create` **shares** the Form object and emits `FormCreated`.

### 3.2 `submission` module

```move
public struct Submission has key, store {
    id: UID,
    form_id: ID,
    blob_id: vector<u8>,          // ASCII bytes of the submission's Walrus blob ID
    submitter: address,
    submitted_at_ms: u64,
    status: u8,                   // 0 NEW · 1 IN_PROGRESS · 2 RESOLVED · 3 SPAM
    priority: u8,                 // 0 LOW · 1 MED · 2 HIGH · 3 URGENT
    tags: vector<String>,
    notes_blob_id: vector<u8>,
    has_notes: bool,
}
```

| Target | Args (in order) |
|---|---|
| `submission::submit` | `&mut Form`, `vector<u8> blob_id`, `&Clock` |
| `submission::set_status` | `&Form`, `&mut Submission`, `u8 status` |
| `submission::set_priority` | `&Form`, `&mut Submission`, `u8 priority` |
| `submission::add_tag` | `&Form`, `&mut Submission`, `String tag` |
| `submission::attach_notes` | `&Form`, `&mut Submission`, `vector<u8> notes_blob_id` |

`submission::submit` bumps the form's count, emits `SubmissionReceived`, and shares
the Submission object. Admin-only mutators assert `form::is_admin(form, sender)`.

### 3.3 `events` module — what you query

| Event (type = `${ORIGINAL_PKG}::events::<Name>`) | Fields |
|---|---|
| `FormCreated` | `form_id: ID`, `owner: address`, `schema_blob_id: vector<u8>` |
| `SubmissionReceived` | `form_id: ID`, `submission_id: ID`, `blob_id: vector<u8>`, `submitter: address`, `submitted_at_ms: u64` |
| `FormUpdated`, `FormStatusChanged`, `AdminAdded`, `AdminRemoved`, `SubmissionStatusChanged`, `SubmissionPriorityChanged`, `SubmissionTagged`, `NotesAttached` | — |

### 3.4 `acl` module — the Seal policy

```move
// tideform::acl
public fun seal_approve(id: vector<u8>, form: &Form, ctx: &TxContext) {
    // 1. first 32 bytes of `id` must equal form's object-ID bytes
    // 2. caller (ctx.sender) must be in form.admins
}
```

Binds every ciphertext to one form **and** restricts decryption to that form's admins.

> Zentos ships a *simpler* ACL — `zentos_acl::acl::seal_approve(id, ctx)` — that only
> checks the **first 32 bytes of `id` == caller's address** (owner-only decryption).
> Tideform uses the form-bound variant above. Pick per app; mobile inbox decryption
> uses Tideform's form-bound `acl`.

---

## 4. The exact moveCall encodings (from `web/src/lib/move.ts`)

`PACKAGE_ID` = the `tideform` package. Note **blob IDs are encoded as `vector<u8>`
of the ASCII string** via `TextEncoder().encode(blobId)`, NOT decoded from base64.

```ts
// form::create
tx.moveCall({
  target: `${PACKAGE_ID}::form::create`,
  arguments: [
    tx.pure.vector("u8", new TextEncoder().encode(schemaBlobId)),
    tx.pure.bool(requireWallet),
    tx.pure.bool(onePerWallet),
    tx.object("0x6"),                       // Clock
  ],
});

// submission::submit
tx.moveCall({
  target: `${PACKAGE_ID}::submission::submit`,
  arguments: [
    tx.object(formId),
    tx.pure.vector("u8", new TextEncoder().encode(blobId)),
    tx.object("0x6"),
  ],
});

// submission::set_status / set_priority
tx.moveCall({
  target: `${PACKAGE_ID}::submission::set_status`,
  arguments: [tx.object(formId), tx.object(submissionId), tx.pure.u8(status)],
});
```

Reading a Form object back (`web/src/lib/indexer.ts`), the parsed Move struct fields are:
`f.owner`, `f.admins.fields.contents` (array of addresses), `f.schema_blob_id` (number[]
→ decode with `TextDecoder`), `f.version`, `f.status`, `f.submissions_count`,
`f.require_wallet`, `f.one_per_wallet`, `f.created_at_ms`, `f.updated_at_ms`.

Submission object fields: `s.form_id`, `s.blob_id` (number[]→string), `s.submitter`,
`s.submitted_at_ms`, `s.status`, `s.priority`, `s.tags`, `s.has_notes`, `s.notes_blob_id`.

---

## 5. Walrus (from `web/src/lib/walrus.ts`)

### Reads — public aggregator, no auth, works from any phone

```
GET ${WALRUS_AGGREGATOR}/v1/blobs/{blobId}   → raw bytes
```
mainnet aggregator: `https://aggregator.walrus-mainnet.walrus.space`
testnet aggregator: `https://aggregator.walrus-testnet.walrus.space`

### Writes — sponsored, via the backend (zero WAL/SUI for the user)

The client POSTs **multipart/form-data** to the app's own `/api/walrus/upload`:

```
fields: file=<bytes>, creator_address=0x..(Sui addr), epochs=5, deletable=true
→ 200 { blob_id, sponsored_blob_id, tx_digest, end_epoch?, wal_cost? }
```

The backend forwards to the Krilly sponsor (`https://walrus-sponsor.krill.tube/v1/upload`)
with a server-only `Authorization: Bearer <WALRUS_SPONSOR_API_KEY>`. The key never
reaches the client. **`blob_id` is what you store on-chain.**

---

## 6. Zentos — the auth/wallet backend the mobile app talks to

Zentos = "Custodial Google → Sui wallet for apps." The web uses it; **mobile reuses
the exact same HTTP endpoints**. The whole point: you do NOT rebuild auth/signing/gas
for mobile — you build a native client over these routes.

### 6.1 Auth

| Route | Body | Returns |
|---|---|---|
| `POST /api/auth/google` | `{ idToken }` (Google ID-token JWT) | `{ address, email, name, picture, isNew }` + sets HMAC session cookie |
| `GET  /api/auth/me` | — (cookie) | `{ address, email, name, picture, isExported }` or 401 |
| `POST /api/auth/logout` | — | clears cookie |

First sign-in mints an `Ed25519Keypair`, AES-256-GCM encrypts the secret, stores it in
Postgres keyed by Google `sub`. **Same Google account → same Sui address forever.**

### 6.2 Signing (custodial + sponsored)

| Route | Body | Returns |
|---|---|---|
| `POST /api/wallet/sign` | `{ txKindBytes }` (base64 of `tx.build({onlyTransactionKind:true})`) | `{ digest, sponsorAddress, senderAddress }` |
| `POST /api/wallet/sign-message` | `{ message }` (base64 bytes) | `{ signature, address }` |
| `POST /api/wallet/export` | — | Bech32 `suiprivkey1…` (self-custody escape hatch) |

`/api/wallet/sign`: server decrypts the user's key in-memory, sets the sponsor wallet as
gas owner, signs as **both** sender (user) and sponsor, executes. **User pays 0 SUI, sees
0 popups.** There's a Move-target allowlist so the sponsor can't be drained by arbitrary
PTBs — only Tideform/Zentos package targets are honored.

`/api/wallet/sign-message`: signs a personal message with the custodial key. This is what
Seal's `SessionKey` flow needs (proof-of-ownership before key servers release shares). On
mobile this replaces the wallet-popup `signPersonalMessage`.

### 6.3 The client signing helper (web → mirror this on mobile)

```ts
// web/src/lib/signer.ts (zentos)
export async function signAndExecuteCustodial(tx, custodialAddress) {
  tx.setSender(custodialAddress);
  const kindBytes = toBase64(await tx.build({ client: suiClient, onlyTransactionKind: true }));
  const res = await fetch("/api/wallet/sign", {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ txKindBytes: kindBytes }),
  });
  return res.json();   // { digest, sponsorAddress, senderAddress }
}
```

---

## 7. Seal (private fields)

Two identity conventions exist; **mobile inbox uses Tideform's form-bound one**:

```
identity bytes = <32-byte form objectID> || ":" || <fieldId> || ":" || <hex nonce>
sealId (hex)   = hex(identity bytes)
```

- **Encrypt** (submit): `client.encrypt({ threshold, packageId, id: sealIdHex, data })`
  → store `{ kind:"encrypted", envelope:{ mode:"seal", b64, id } }` for small values,
  or upload ciphertext to Walrus + keep `{ kind:"encrypted-media", blobId, sealId, … }`.
- **Decrypt** (admin inbox): build a PTB calling `acl::seal_approve(idBytes, form)`,
  `tx.build({ onlyTransactionKind:true })`, then
  `client.decrypt({ data, sessionKey, txBytes })`. The `SessionKey` is created with the
  user's address+packageId and signed via `/api/wallet/sign-message` (custodial) — see §6.2.

Mainnet Seal key server (free, public, threshold 1):
`0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a`

> **Mobile reality:** `@mysten/seal` is browser/Node-oriented. In **Expo** it can run
> with crypto polyfills (best-effort; document it). In **Swift** there is no Seal SDK —
> the mobile Swift app should treat private-field decryption as a documented
> backend-delegated step or skip private fields in the v1 teaching scope. **Public
> fields work fully on both stacks.** Never claim placeholder mode is real encryption.

---

## 8. Form schema + submission JSON (from `web/src/lib/schema.ts`)

Field types (14): `short_text, long_text, rich_text, dropdown, multi_select, checkbox,
rating, screenshot, video, url, number, date, email, wallet`.

```
FormSchema {
  version, formVersion, title, description, bannerBlobId?,
  theme { primary, mode },
  settings { requireWallet, onePerWallet, captcha, successMessage, style:"compact"|"conversational", redirectUrl?, ... },
  sections: [ { id, title?, fields: Field[] } ],
}
Field { id, type, label, help?, placeholder?, required, private, defaultValue?, validation?, options?, conditional? }
```

The form schema JSON is uploaded to Walrus; its blob ID is `schema_blob_id` on-chain.

```
Submission {
  formId, formVersion, submittedAt (ISO), submitter?,
  fields: { [fieldId]: FieldValue },
}
FieldValue =
  | { kind:"plaintext", value }
  | { kind:"media", blobId, mime, bytes, name }
  | { kind:"encrypted", envelope:{ mode:"seal"|"placeholder", b64, id? } }
  | { kind:"encrypted-media", blobId, sealId, mime, bytes, name }
```

The submission JSON is uploaded to Walrus; its blob ID is the `blob_id` arg to
`submission::submit`.

---

## 9. The end-to-end flows the mobile apps must implement

**A. Sign in** — native Google sign-in → Google ID token → `POST /api/auth/google`
→ persist the Set-Cookie session → store `{address,email,name,picture}`. (Reads `/api/auth/me`
on launch to restore session.)

**B. My forms** — `queryEvents({ MoveEventType: ORIGINAL_PKG::events::FormCreated })`,
filter `parsedJson.owner == myAddress` → `multiGetObjects(formIds)` → fetch each
`schema_blob_id` from the Walrus aggregator → show titles.

**C. View / fill a form** — read the Form object + its schema blob → render fields by
type → collect values.

**D. Submit** — assemble the `Submission` JSON (encrypt private fields if in scope) →
`POST /api/walrus/upload` (sponsored) → get `blob_id` → build `submission::submit` PTB
→ `tx.build({onlyTransactionKind:true})` → `POST /api/wallet/sign` → show the tx digest
+ Walrus receipt. **Zero gas, zero popups.**

**E. Admin inbox** — `queryEvents(SubmissionReceived)` filter by `form_id` →
`multiGetObjects(submissionIds)` → fetch payload blobs from Walrus → render; decrypt
private fields via Seal + `/api/wallet/sign-message` (Expo best-effort; Swift documented).

---

## 10. The mobile `lib/` API contract (BOTH stacks expose the same surface)

This is the teaching parallel: the Expo `lib/` and the Swift `Lib/` expose the **same
named functions** so the class can diff them.

| Concern | Function(s) |
|---|---|
| Env/config | `env` — `network, packageId, originalPackageId, walrusAggregator, backendBaseUrl, googleClientId, sealKeyServers, sealThreshold` |
| Sui client | `suiClient` (fullnode for `network`) |
| Reads/indexer | `listFormsForOwner(addr)`, `fetchForm(id)`, `fetchFormSchema(blobId)`, `listSubmissions(formId)`, `fetchSubmissionPayload(blobId)` |
| Walrus | `readBlob(id)`, `readJson(id)`, `uploadBlob(bytes, {owner,…})`, `uploadJson(obj, {owner,…})`, `blobUrl(id)` |
| Move tx builders | `txCreateForm`, `txSubmit`, `txSetFormStatus`, `txSubmissionStatus`, `txSubmissionPriority`, `txAttachNotes`, `txAddTag` |
| Auth (zentos client) | `signInWithGoogle(idToken)`, `getMe()`, `signOut()` |
| Sign (zentos client) | `signAndExecuteCustodial(tx, address)`, `custodialSignMessage()` |
| Schema/types | `FieldType`, `Field`, `FormSchema`, `Submission`, `FieldValue` |

`backendBaseUrl` defaults to the live `https://tidalform.xyz` (so the app works out of the
box) and is overridable to a self-hosted zentos instance or localhost.

---

## 11. Auth-model arc across the two workshop days

| | **Day 1** | **Day 2 (this)** |
|---|---|---|
| Model | zkLogin (non-custodial, on-device) | Zentos custodial (server-held key, sponsored) |
| Key custody | User's ephemeral key + ZK proof | Server (AES-256-GCM encrypted), **exportable** any time |
| Mobile fit | Prover round-trips on device | Thin native client over the backend (simplest) |
| Where | Day 1 repo | This repo |

Day 1 taught **zkLogin** (non-custodial). Day 2 teaches the **Zentos custodial backend**
model and how a mobile app is *just a native client* over it: native Google sign-in →
backend session, reads happen on-device, writes are custodially signed + gas-sponsored by
the backend.

**Yes, custodial = centralized by design — and for consumer onboarding that's the point.**
No seed phrase, no extension, no gas, no popups. The trust trade-off is explicit and bounded:
the server holds an AES-encrypted key, and `POST /api/wallet/export` hands the user a
Bech32 `suiprivkey1…` so they can walk to self-custody whenever they want. Do **not** pull
in any self-hosted-prover or decentralized-zkLogin machinery for this build — the mobile
port is the **direct Zentos custodial logic**, nothing more.

---

## 12. Mobile-specific gotchas (call these out in the walkthroughs)

- **Session cookies**: the backend sets an HttpOnly cookie. Expo `fetch` doesn't persist
  cookies like a browser — capture the `Set-Cookie` from `/api/auth/google`, store it in
  `expo-secure-store`, and send it back as a `Cookie` header on every privileged call.
  Swift: use a shared `URLSession` with `HTTPCookieStorage` (persists automatically) or
  capture the header manually.
- **Google sign-in**: Expo → `expo-auth-session` (or `@react-native-google-signin`),
  responseType id_token, scopes `openid email`. Swift → `GoogleSignIn-iOS`. Both yield the
  ID token you POST to `/api/auth/google`.
- **No wallet extension** exists on mobile — that's the whole reason for the backend model.
- **Reads need no backend**: querying events, objects, and Walrus blobs works straight from
  the device against public endpoints.
- **Blob IDs are stored as ASCII `vector<u8>`** on-chain — decode with UTF-8, do not base64-
  decode.
- Always show the **gasless** story in the demo: submit a form and point out there was no
  gas prompt and no SUI in the wallet.
