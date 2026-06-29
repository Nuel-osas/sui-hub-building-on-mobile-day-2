# Patterns — do / don't and the errors that eat mobile launches

## Do / Don't

**DO**
- Read all IDs from `env` (env-overridable). Default `backendBaseUrl` to
  `https://tidalform.xyz` so the app works out of the box.
- Use `originalPackageId` for **event type** queries, `packageId` for **moveCall**
  targets. They happen to be equal at v1 — code as if they differ, so an upgrade doesn't
  break reads.
- Decode on-chain blob IDs with `TextDecoder` (UTF-8). They're ASCII `vector<u8>`.
- Encode blob IDs for moveCall with `new TextEncoder().encode(blobId)` and
  `tx.pure.vector("u8", ...)`.
- `import "react-native-get-random-values"` as the very first line of your entry path,
  before any `@mysten/sui` import.
- Build only the **transaction kind** on device (`onlyTransactionKind: true`) and let the
  custodial sponsor own gas + sign.
- Persist the session cookie in `expo-secure-store` and re-send it as a `Cookie` header.
- Surface the **tx digest + Walrus blob id** as the success receipt.
- Keep reads (events/objects/Walrus) un-gated — they need no login.

**DON'T**
- Don't `base64`-decode blob IDs. Don't `tx.pure.string` them into Move (the contract
  wants `vector<u8>`).
- Don't sign privileged transactions on the device in the custodial model — that's the
  backend's job (gasless + popup-less is the whole point).
- Don't show a "confirm in wallet" / gas-approval UI in the custodial model. There is no
  wallet and no gas prompt.
- Don't hard-code mainnet IDs in business logic; route them through `env`.
- Don't assume Expo `fetch` persists cookies like a browser. It doesn't.
- Don't claim Seal "placeholder" mode is real encryption (see below).

## Common errors

### `redirect_uri_mismatch` (Google OAuth)
The `redirectUri` from `AuthSession.makeRedirectUri({ scheme: "tideform" })` must be
registered **verbatim** in the Google Cloud console for that OAuth client.
- Log the exact value at runtime and paste it into "Authorized redirect URIs".
- In Expo Go the URI looks like `exp://…`; a standalone/dev-client build uses your
  `scheme` (`tideform://…`). These are **different** URIs — register the one your build
  actually produces, and use a **dev client** (`expo-dev-client`) rather than Expo Go for
  custom-scheme OAuth.
- Native iOS/Android OAuth client types each need their own redirect entry. // VERIFY:
  which OAuth client type (Web vs iOS vs Android) your `googleClientId` is.

### Cookies not persisting / 401 on every privileged call
Symptom: `/api/auth/me` returns 401 right after a successful `/api/auth/google`.
- You didn't capture `Set-Cookie`. Use `authedFetch` (`lib/http.ts`) which reads
  `res.headers.get("set-cookie")`, stores `name=value` in `expo-secure-store`, and
  re-attaches it. See `zentos-backend.md`.
- React Native folds multiple `Set-Cookie` headers into one comma-joined string. Tideform
  sets a single session cookie, so taking the substring before the first `;` is safe. If
  you add more cookies, parse each one (Expires dates contain commas). // VERIFY.
- RN's native networking sometimes also keeps its own cookie store, which can mask or
  fight your manual handling — the manual capture-and-resend approach in this kit is the
  reliable path.

### `crypto.getRandomValues is not supported` / keypair gen throws
You forgot the polyfill. `import "react-native-get-random-values"` must run **before**
`@mysten/sui` loads (it's used by `Ed25519Keypair.generate()`, `generateRandomness`, and
nonce generation). Put it first in `lib/polyfills.ts` and import that first.

### `TextEncoder is not defined` / `TextDecoder is not defined`
Recent Expo SDKs (Hermes) ship these. On older runtimes add a polyfill
(`import "fast-text-encoding";`) in `lib/polyfills.ts`. This matters because **blob-id
decode/encode depends on `TextEncoder`/`TextDecoder`.**

### base64-vs-ASCII blob IDs (silent data corruption)
The nastiest bug because it doesn't throw — it just produces a wrong blob id and a 404
from the aggregator. On-chain `schema_blob_id` / `blob_id` are the **ASCII bytes of a
base64url string**, returned by RPC as a `number[]`.
- ✅ `new TextDecoder().decode(Uint8Array.from(raw))`
- ❌ `Buffer.from(raw).toString("base64")` / `atob(...)` — corrupts the id.
See the worked example in `reads.md`.

### Walrus upload fails / empty body in React Native
You can't append raw bytes to `FormData` in RN. Stage the bytes to a file URI with
`expo-file-system`, then append `{ uri, name, type }`. And **don't** set `Content-Type`
manually on the multipart request — let `fetch` set the boundary. See `uploadBlob` in
`zentos-backend.md`.

### `wallet/sign` rejects your PTB (allowlist)
The sponsor enforces a **Move-target allowlist** (only Tideform/Zentos package targets) so
it can't be drained. If you call a non-allowlisted target it's refused. Use the `txXxx`
builders in `lib/move.ts`; don't hand-roll arbitrary `moveCall`s through the sponsor.

### zkLogin: wrong / unstable address across devices
The address is `jwtToAddress(jwt, salt)`. A different `salt` → a different address. The
dev quickstart stores a random per-install salt (fine for testnet demos), but for a real
app the **same Google account must map to the same salt on every device** — use a salt
service keyed by the JWT `sub`. // VERIFY: production salt service URL. (The Day-2
custodial model sidesteps this entirely: the backend derives one stable address per
Google `sub`.)

### zkLogin: prover errors / proof rejected
- Wrong prover for the network. Dev/testnet and mainnet prover endpoints differ; for
  production you typically self-host or use a hosted prover. // VERIFY prover URL.
- `maxEpoch` already passed — the proof is only valid until `maxEpoch`. Regenerate the
  ephemeral key + nonce + proof when the epoch window lapses (a backgrounded app can
  outlive it).
- `nonce` mismatch — the `nonce` you sent to Google must be the one derived from the
  ephemeral pubkey + `maxEpoch` + `randomness`, and you must reuse the **same** randomness
  when requesting the proof.

## Seal-in-React-Native caveats (private fields)

`@mysten/seal` is browser/Node-oriented. In **Expo** it can run **best-effort** with crypto
polyfills — document it as best-effort, not guaranteed.

- **Public fields work fully** on device, both stacks. Encryption is only for fields
  marked `private: true`.
- **Identity layout (Tideform form-bound):**
  `identity bytes = <32-byte form objectID> || ":" || <fieldId> || ":" || <hex nonce>`;
  `sealId = hex(identity bytes)`. The mobile inbox uses this form-bound `acl::seal_approve`
  (decryptable only by that form's admins) — not Zentos's owner-only variant.
- **Encrypt (submit):** `client.encrypt({ threshold: env.sealThreshold, packageId,
  id: sealIdHex, data })` → store `{ kind: "encrypted", envelope: { mode: "seal", b64, id } }`
  (small values) or upload ciphertext to Walrus and keep `{ kind: "encrypted-media",
  blobId, sealId, ... }`.
- **Decrypt (admin inbox):** build a PTB calling `acl::seal_approve(idBytes, form)`,
  `tx.build({ onlyTransactionKind: true })`, then `client.decrypt({ data, sessionKey,
  txBytes })`. The `SessionKey` is created with the user's address + `packageId` and signed
  via **`custodialSignMessage`** (`/api/wallet/sign-message`) — that replaces the wallet
  popup `signPersonalMessage`.
- Mainnet Seal key server (free, public, threshold 1):
  `0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a` (in `env.sealKeyServers`).
- **Never claim `mode: "placeholder"` is real encryption.** It is a non-encrypted stand-in.
  If Seal can't run, either skip private fields in scope or mark them clearly as
  unencrypted — don't fake it. (In **Swift** there is no Seal SDK at all: treat
  private-field decryption as a documented backend-delegated step or out of v1 scope.)

## Mobile-specific reminders

- **No wallet extension exists on mobile** — that's the entire reason for the backend
  (custodial) model and zkLogin (non-custodial) model. Never wire a "connect wallet" UI.
- **Backgrounded sessions:** zkLogin proofs expire with `maxEpoch`; session cookies expire
  too. On resume, re-validate (`getMe()` for custodial; re-prove for zkLogin) and fall
  back to the login screen gracefully.
- **Always demo the gasless story:** submit a form, then point out there was no gas prompt
  and there is no SUI in the wallet. That's the moment that sells the architecture.
