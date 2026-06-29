# Tideform — Expo (iOS + Android)

A cross-platform **Expo / React Native** port of **Tideform** (live at
[tidalform.xyz](https://tidalform.xyz)) — a Walrus-native feedback & form platform on Sui.
This is the **Day 2** teaching artifact. It mirrors the production web app's `lib/` surface
one-for-one (see [`docs/00-architecture-source-of-truth.md`](../docs/00-architecture-source-of-truth.md)
§10) so the class can diff web → mobile, and its native sibling `tideform-swift/` exposes the
**same named functions** so you can diff Expo → Swift.

> **Auth model (Day 2): Zentos *custodial*.** Native Google sign-in →
> `POST /api/auth/google` → session cookie. Privileged ops (sign a tx, sign a message,
> sponsored Walrus upload) go to the backend. Reads (events, objects, Walrus blobs) happen
> **directly on the device** against public endpoints.

> **The headline UX is gasless + popup-less.** Submitting a form prompts for **zero gas** and
> needs **zero SUI** in the wallet — the Zentos backend sets its sponsor wallet as gas owner
> and co-signs as both sender (you) and sponsor. No seed phrase, no extension, no "approve in
> wallet" chain.

Day 1 taught **zkLogin** (non-custodial, on-device prover round-trip) — see
[`../../day1-mobile-foundations.md`](../../day1-mobile-foundations.md). Day 2 reframes the
mobile app as *just a thin client* over the custodial backend (`zentos`). The full auth-model
arc is in [`docs/03-auth-models-day1-vs-day2.md`](../docs/03-auth-models-day1-vs-day2.md) and
source-of-truth §11.

---

## What this app is

```
tideform-expo/
├─ app/                      # Expo Router screens (the UI layer — this stage)
│  ├─ _layout.tsx            # root Stack + auth guard; restores session on launch
│  ├─ login.tsx              # Flow A · Google sign-in → custodial Sui wallet
│  ├─ index.tsx              # Flow B · "My Forms" (listFormsForOwner)
│  ├─ f/[id].tsx             # Flows C+D · view + fill a form → gasless submit
│  └─ inbox/[id].tsx         # Flow E · admin inbox (read submissions, Seal best-effort)
├─ components/
│  ├─ field-renderer.tsx     # all 14 field types — input + read-only modes
│  └─ receipt.tsx            # tx digest → SuiVision, blob ID → Walruscan
├─ lib/                      # the shared lib contract (already written — do not rebuild)
│  ├─ env.ts  sui.ts  schema.ts  indexer.ts  walrus.ts  move.ts
│  ├─ api.ts (ZentosClient)  auth.ts (useAuth)  cookies.ts  seal.ts
│  └─ index.ts              # one re-exported surface: `import { ... } from '@/lib'`
├─ .env.example
├─ app.json  package.json  tsconfig.json
├─ README.md                # ← you are here
└─ WALKTHROUGH.md           # build-it-yourself, screen by screen, mirroring the web app
```

The **UI layer** (everything in `app/` + `components/`) is the deliverable of this stage. It is
built entirely on top of the pre-written `lib/`, importing only its real exports
(`useAuth`, `listFormsForOwner`, `fetchForm`, `fetchFormSchema`, `uploadJson`, `txSubmit`,
`signAndExecuteCustodial`, `listSubmissions`, `fetchSubmissionPayload`, `sealEncryptText`,
`createCustodialSessionKey`, `sealDecrypt`, `blobUrl`, `env`, and the `Field` / `FormSchema` /
`Submission` / `FieldValue` types). Nothing in `app/` invents an on-chain ID, endpoint, Move
target, or SDK method.

---

## Prerequisites

- **Node.js 20+** and a package manager (`npm`, `pnpm`, or `yarn`).
- The **Expo CLI** is invoked via `npx` / the `expo` dependency — no global install required.
- A device or simulator:
  - **iOS**: Xcode 15+ with the iOS Simulator (macOS only), or the **Expo Go** app on a real
    iPhone.
  - **Android**: Android Studio + an emulator, or **Expo Go** on a real Android device.
- A **Google OAuth client ID** for native sign-in (see [Google sign-in](#google-sign-in-setup)
  below). This is the only value with **no baked-in default** — everything else falls back to
  the live mainnet config, so the rest of the app runs out of the box.

> **Reads need no backend and no auth.** Browsing forms, reading the schema, and viewing
> Walrus blobs work straight from the device against public endpoints. You only need the
> backend (and a signed-in session) for the *privileged* steps: sponsored upload + custodial
> sign.

---

## Install

```sh
npm install          # or: pnpm install  /  yarn
```

Key dependencies (already pinned in `package.json`):

| Package | Why |
|---|---|
| `expo` ~52, `expo-router` ~4 | app shell + file-based routing |
| `@mysten/sui` | `SuiClient` reads + `Transaction` (PTB) builders |
| `@mysten/seal` | best-effort Seal encrypt/decrypt for private fields |
| `expo-auth-session`, `expo-web-browser` | native Google sign-in (id_token) |
| `expo-secure-store` | persists the captured session cookie |
| `expo-file-system` | stages bytes for the sponsored multipart Walrus upload |
| `expo-crypto`, `react-native-get-random-values` | crypto polyfills the SDKs need |

---

## `.env` setup

Every runtime value is read from an `EXPO_PUBLIC_*` variable and **falls back to the production
mainnet default** in `lib/env.ts`, so the app runs with an empty `.env`. Copy the example and
fill in only what you want to override:

```sh
cp .env.example .env
```

```ini
# Sui network the read-side fullnode targets: mainnet | testnet | devnet | localnet
EXPO_PUBLIC_SUI_NETWORK=mainnet

# tideform package — `published-at` (moveCall targets) and `original-id` (event TYPE queries).
# On v1 mainnet these are identical.
EXPO_PUBLIC_TIDEFORM_PACKAGE_ID=0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4
EXPO_PUBLIC_TIDEFORM_ORIGINAL_PACKAGE_ID=0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4

# Public Walrus aggregator for device-side blob reads.
EXPO_PUBLIC_WALRUS_AGGREGATOR=https://aggregator.walrus-mainnet.walrus.space

# Zentos backend: custodial auth + sponsored signing + sponsored Walrus upload.
# Defaults to the live deployment so the app works out of the box.
EXPO_PUBLIC_BACKEND_BASE_URL=https://tidalform.xyz

# Google OAuth client ID for native sign-in. NO DEFAULT — supply your own (see below).
EXPO_PUBLIC_GOOGLE_CLIENT_ID=

# Seal key server(s) + threshold (mainnet free public server, threshold 1).
EXPO_PUBLIC_SEAL_KEY_SERVERS=0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a
EXPO_PUBLIC_SEAL_THRESHOLD=1
```

> **`EXPO_PUBLIC_*` is inlined into the JS bundle and is therefore PUBLIC.** Never put a secret
> here. All privileged secrets — the custodial key, the gas sponsor, the Walrus sponsor API key
> — live **only** in the Zentos backend. The mobile app is a thin client (source-of-truth §6, §12).

### Switching to testnet for a workshop

Set `EXPO_PUBLIC_SUI_NETWORK=testnet`, republish `tideform` to testnet, swap both package IDs,
and point `EXPO_PUBLIC_WALRUS_AGGREGATOR` at
`https://aggregator.walrus-testnet.walrus.space`. Nothing is hard-coded beyond the fallback
defaults in `lib/env.ts`.

### Google sign-in setup

`lib/auth.ts` uses `expo-auth-session`'s Google provider
(`Google.useIdTokenAuthRequest({ clientId: env.googleClientId })`) with `responseType: id_token`
and `openid email` scopes. That yields the **Google ID-token JWT** which
`POST /api/auth/google` exchanges for your custodial Sui wallet. **Same Google account → same
Sui address, forever** (the backend keys the wallet by Google `sub`).

1. In **Google Cloud Console → APIs & Services → Credentials**, create OAuth client ID(s) for
   the platform(s) you'll run on (iOS / Android / Web). The bundle/package identifier is
   `xyz.tidalform.tideform` (see `app.json`); the app scheme is `tideform`.
2. Put the client ID in `EXPO_PUBLIC_GOOGLE_CLIENT_ID`.
3. If the client ID is unset, the login screen shows a yellow hint and the button is disabled —
   the rest of the app (reads) still loads.

> `// VERIFY` (already flagged in `lib/auth.ts`): some `expo-auth-session` versions spell the
> hook `Google.useAuthRequest({ responseType: 'id_token' })`; the id_token lands in
> `response.params.id_token` either way, and the screen does not change. If you target iOS +
> Android + web with distinct client IDs, pass them through `lib/env.ts` and widen the hook
> call — the UI layer never needs to know.

---

## Run on iOS + Android

```sh
npm start            # Metro dev server + QR code (open in Expo Go)
npm run ios          # build + open the iOS Simulator   (macOS + Xcode)
npm run android      # build + open the Android emulator (Android Studio)
npm run lint         # tsc --noEmit — typecheck the whole app against the lib contract
```

- **Expo Go (fastest):** `npm start`, then scan the QR with the Expo Go app on a real phone.
  Reads, sponsored submit, and Google sign-in all work in Expo Go.
- **Simulator / emulator:** `npm run ios` / `npm run android`. Sign in with Google and you'll
  have a Sui address with **zero SUI** — submitting a form *still works* because gas is
  sponsored. That's the demo.

> **Demo tip:** after a submit, the receipt screen shows the **tx digest** (deep-links to
> SuiVision) and the **Walrus blob ID** (deep-links to Walruscan + the raw aggregator). Point
> out there was **no gas prompt and no SUI** in the wallet.

---

## The five end-to-end flows (source-of-truth §9)

| | Screen | What it does | Key lib calls |
|---|---|---|---|
| **A · Sign in** | `app/login.tsx` | native Google sign-in → ID token → custodial Sui wallet + session cookie. On launch, `app/_layout.tsx` restores the session. | `useAuth().signIn()` → `signInWithGoogle` → cookie persisted; `restore()` → `getMe()` |
| **B · My forms** | `app/index.tsx` | query `FormCreated` by the *original* package type, keep forms you own, `multiGetObjects`, fetch each schema blob for its title. All on-device, no cookie. | `listFormsForOwner(address)`, `fetchFormSchema(blobId)` |
| **C · View / fill** | `app/f/[id].tsx` | read the `Form` + its schema blob, render every field by type, collect values. | `fetchForm(id)`, `fetchFormSchema(blobId)`, `<FieldRenderer>` |
| **D · Submit** | `app/f/[id].tsx` | assemble the `Submission` JSON (Seal-encrypt private fields best-effort) → sponsored Walrus upload → `submission::submit` PTB → custodial co-sign + execute → show digest + receipt. **0 gas, 0 popups.** | `sealEncryptText`, `uploadJson`, `txSubmit`, `signAndExecuteCustodial`, `<Receipt>` |
| **E · Admin inbox** | `app/inbox/[id].tsx` | query `SubmissionReceived` by `form_id`, `multiGetObjects`, fetch payload blobs, render. Private fields: Seal decrypt best-effort, else labeled. | `listSubmissions(formId)`, `fetchSubmissionPayload`, `createCustodialSessionKey`, `sealDecrypt` |

A step-by-step "build each of these yourself" guide is in
[`WALKTHROUGH.md`](./WALKTHROUGH.md).

---

## The gasless / popup-less story (read this for the demo)

Submitting a form (Flow D) touches the backend **exactly twice** — and only because both steps
need a server-held secret:

1. **Sponsored Walrus upload** — `uploadJson(submission, { owner })` POSTs multipart to
   `/api/walrus/upload`. The backend forwards to the Walrus sponsor with a server-only API key.
   The returned `blob_id` is what goes on-chain. The user pays **0 WAL / 0 SUI**.
2. **Custodial co-sign + sponsor** — `signAndExecuteCustodial(tx, address)` calls
   `tx.setSender(address)`, serializes only the transaction **KIND bytes**
   (`tx.build({ onlyTransactionKind: true })`), and POSTs them to `/api/wallet/sign`. The
   backend decrypts the user's key in-memory, sets its **sponsor wallet** as gas owner, signs
   as both sender (the user) **and** sponsor, and executes. The user pays **0 SUI** and sees
   **0 popups**. (A Move-target allowlist stops the sponsor from being drained by arbitrary
   PTBs — only Tideform/Zentos targets are honored.)

Everything else — building the PTB, reading the form, fetching blobs — is local. The
[`components/receipt.tsx`](./components/receipt.tsx) badge spells the whole pitch out:
`⚡ 0 SUI gas · 0 popups · sponsored by Zentos`.

---

## What's backend-delegated / out of scope (be honest about it)

- **Signing & gas** — never on device. `/api/wallet/sign` co-signs as user + sponsor and
  executes. The phone only ships base64 `txKindBytes`.
- **Sponsored Walrus uploads** — `/api/walrus/upload`. The Walrus sponsor API key never reaches
  the client.
- **Seal private-field DECRYPTION (inbox)** — **best-effort.** `@mysten/seal` needs WebCrypto
  `crypto.subtle`, which Hermes/JSC on React Native usually does **not** provide. So:
  - **Encryption (submit):** real Seal when WebCrypto is present (`mode:"seal"`), otherwise a
    **clearly-labeled non-encrypting placeholder** (`mode:"placeholder"`) that base64-wraps the
    plaintext so the teaching flow still runs end-to-end. **The placeholder is never called real
    encryption** — `lib/seal.ts` tags it and the inbox renders a loud `⚠ PLACEHOLDER — not
    encrypted` badge.
  - **Decryption (inbox):** needs WebCrypto + a Seal `SessionKey` signed via
    `/api/wallet/sign-message` (custodial). Where WebCrypto is absent, the inbox shows a
    documented *"decryption unavailable on this runtime"* state — never faked. Decryption also
    requires you to be an **admin/owner** of the form (the `tideform::acl::seal_approve` policy:
    first 32 bytes of the Seal id == form object ID, **and** caller ∈ form admins).
  - **Public fields work fully on device** on both stacks.
- **Native media / date pickers** — `screenshot` / `video` fields accept a Walrus blob ID or
  URL, and `date` is a typed `YYYY-MM-DD`. Wiring `expo-image-picker` /
  `@react-native-community/datetimepicker` is a documented next step (this stage ships only the
  base dep set). Both are labeled in the UI.

> See source-of-truth §7 (Seal), §6 (Zentos), §12 (mobile gotchas) for the authoritative
> contract behind every boundary above.

---

## On-chain facts (Sui MAINNET, source-of-truth §2)

```
tideform package (published-at / original-id) = 0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4
Clock object                                   = 0x6 (shared)
Walrus aggregator (mainnet)                    = https://aggregator.walrus-mainnet.walrus.space
Seal key server (mainnet, threshold 1)         = 0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a
Backend (zentos)                               = https://tidalform.xyz
```

**Blob IDs are stored on-chain as `vector<u8>` of their ASCII bytes** — decode with UTF-8,
never base64 (source-of-truth §4 / §12). `lib/indexer.ts#decodeAsciiBlobId` and
`lib/move.ts#asciiBytes` enforce this; the UI never touches raw bytes.

---

## Related reading

- [`../docs/00-architecture-source-of-truth.md`](../docs/00-architecture-source-of-truth.md) —
  the ground truth: IDs, endpoints, Move targets, type shapes, Seal layout, gotchas.
- [`../docs/01-web-to-mobile-map.md`](../docs/01-web-to-mobile-map.md) — every web `lib/` file →
  its mobile equivalent, and where the device/backend line falls.
- [`../docs/02-zentos-and-sponsorship.md`](../docs/02-zentos-and-sponsorship.md) — how gasless +
  popup-less actually works.
- [`../docs/03-auth-models-day1-vs-day2.md`](../docs/03-auth-models-day1-vs-day2.md) — zkLogin
  (Day 1) vs Zentos custodial (Day 2).
- [`../tideform-swift/README.md`](../tideform-swift/README.md) — the native SwiftUI sibling with
  the same lib surface.
- **Day 1:** [`../../day1-mobile-foundations.md`](../../day1-mobile-foundations.md) — the
  zkLogin foundations this builds on.
