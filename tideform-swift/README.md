# Tideform — Swift (native SwiftUI iOS)

A native SwiftUI iOS port of **Tideform** (live at [tidalform.xyz](https://tidalform.xyz)) — a
Walrus-native feedback & form platform on Sui. This repo is the **Day 2** teaching artifact: it
mirrors the Expo `lib/` surface one-for-one in Swift `Lib/`, so the class can diff the two stacks
side by side.

> Auth model (Day 2): **Zentos custodial**. Native Google sign-in → `POST /api/auth/google` →
> session cookie. Privileged ops (sign, sign-message, sponsored Walrus upload) go to the backend.
> Reads (events, objects, Walrus blobs) happen **directly on-device** against public endpoints.
> The headline UX is **gasless + popup-less**: submitting a form prompts for zero gas and needs
> zero SUI in the wallet.

Day 1 taught **zkLogin** (non-custodial, on-device prover) — see `mobile-week/day1-mobile-foundations.md`.
Day 2 reframes the mobile app as *just a thin client* over the custodial backend (`zentos`). The
full auth-model arc (Day 1 zkLogin vs Day 2 Zentos custodial) is in
`docs/03-auth-models-day1-vs-day2.md` and `docs/00-architecture-source-of-truth.md` §11.

---

## What's in this layer

This task delivers the **Lib layer** only — the same named surface as the Expo `lib/`:

```
tideform-swift/
├─ Config.xcconfig.example          # env → build settings (copy to Config.xcconfig)
├─ README.md
└─ Sources/Tideform/Lib/
   ├─ Env.swift          # env: network, packageId, originalPackageId, walrusAggregator,
   │                     #      backendBaseUrl, googleClientId, sealKeyServers, sealThreshold
   ├─ SuiClient.swift    # URLSession JSON-RPC: queryEvents / multiGetObjects / getObject
   ├─ Schema.swift       # FieldType, Field, FormSchema, Submission, FieldValue (+ JSONValue)
   ├─ Walrus.swift       # readBlob/readJson, uploadBlob/uploadJson (sponsored), blobUrl
   ├─ Move.swift         # SuiKit PTB builders: txCreateForm, txSubmit, txSetFormStatus,
   │                     #   txSubmissionStatus, txSubmissionPriority, txAttachNotes, txAddTag
   ├─ Indexer.swift      # listFormsForOwner, fetchForm, fetchFormSchema, listSubmissions,
   │                     #   fetchSubmissionPayload  (decodes ASCII blob IDs + Move structs)
   └─ ZentosClient.swift # auth: signInWithGoogle/getMe/signOut · sign: signAndExecuteCustodial,
                         #   custodialSignMessage  (+ shared cookie-aware tideformURLSession)
```

The **UI layer** (SwiftUI screens) and the **Google sign-in plumbing** (which yields the ID token)
sit on top of this and are out of scope for this file — but the contract they call is fully here.

### The lib API contract (identical to Expo)

| Concern | Swift surface |
|---|---|
| Env/config | `env.network`, `env.packageId`, `env.originalPackageId`, `env.walrusAggregator`, `env.backendBaseUrl`, `env.googleClientId`, `env.sealKeyServers`, `env.sealThreshold` |
| Sui client | `SuiClient.shared` — `queryEvents`, `queryAllEvents`, `multiGetObjects`, `getObject` |
| Indexer | `indexer.listFormsForOwner(_:)`, `fetchForm(_:)`, `fetchFormSchema(_:)`, `listSubmissions(_:)`, `fetchSubmissionPayload(_:)` |
| Walrus | `walrus.readBlob(_:)`, `readJson(_:id:)`, `uploadBlob(_:owner:)`, `uploadJson(_:owner:)`, `blobUrl(_:)` |
| Move tx builders | `Move.txCreateForm`, `txSubmit`, `txSetFormStatus`, `txSubmissionStatus`, `txSubmissionPriority`, `txAttachNotes`, `txAddTag` |
| Auth | `zentos.signInWithGoogle(idToken:)`, `getMe()`, `signOut()` |
| Sign | `zentos.signAndExecuteCustodial(tx:address:)` / `(kindBytesBase64:address:)`, `custodialSignMessage(messageBase64:)` |
| Schema/types | `FieldType`, `Field`, `FormSchema`, `Submission`, `FieldValue` |

---

## Xcode setup

Requires **Xcode 15+**, iOS 16+ deployment target (async/await + `URLSession.data(for:)`).

### 1. Create / open the app

Create a SwiftUI **App** project (e.g. `Tideform`) and add the files under
`Sources/Tideform/Lib/` to the app target (drag the `Lib` group in, "Create groups", ensure
**Target Membership** is checked).

### 2. Add dependencies via Swift Package Manager

**File ▸ Add Package Dependencies…** and add:

| Package | URL | Product |
|---|---|---|
| **SuiKit** (OpenDive) | `https://github.com/OpenDive/SuiKit` | `SuiKit` |
| **GoogleSignIn-iOS** | `https://github.com/google/GoogleSignIn-iOS` | `GoogleSignIn` (+ `GoogleSignInSwift` for SwiftUI) |

- `Move.swift` and `ZentosClient.swift` `import SuiKit`.
- `GoogleSignIn` is used by the **UI layer** to obtain the Google **ID token**; the Lib layer's
  `ZentosClient.signInWithGoogle(idToken:)` just takes that token string — so the Lib itself does
  not import GoogleSignIn.

> If SuiKit method names differ on your pinned version, search the Lib for `// VERIFY: SuiKit API`
> — every version-sensitive call is flagged there (see "SuiKit VERIFY notes" below).

### 3. Google sign-in config (UI layer)

- Create an **iOS OAuth client** in Google Cloud Console; put its **client id** in
  `GOOGLE_CLIENT_ID` (Config.xcconfig).
- Add the **reversed client id** as a URL Type (Info ▸ URL Types).
- The same Google account always maps to the **same Sui address** (the backend keys the custodial
  wallet by Google `sub`).

### 4. Environment via xcconfig

```sh
cp Config.xcconfig.example Config.xcconfig    # then edit; Config.xcconfig is gitignored
```

In Xcode: **Project ▸ Info ▸ Configurations** → set both **Debug** and **Release** to use
`Config.xcconfig`.

#### Wiring xcconfig → Info.plist

Build settings are not visible at runtime until you surface them through Info.plist. Add these
keys to your app's **Info.plist** (each value references the build setting):

```xml
<key>SUI_NETWORK</key><string>$(SUI_NETWORK)</string>
<key>TIDEFORM_PACKAGE_ID</key><string>$(TIDEFORM_PACKAGE_ID)</string>
<key>TIDEFORM_ORIGINAL_PACKAGE_ID</key><string>$(TIDEFORM_ORIGINAL_PACKAGE_ID)</string>
<key>WALRUS_AGGREGATOR</key><string>$(WALRUS_AGGREGATOR)</string>
<key>BACKEND_BASE_URL</key><string>$(BACKEND_BASE_URL)</string>
<key>GOOGLE_CLIENT_ID</key><string>$(GOOGLE_CLIENT_ID)</string>
<key>SEAL_KEY_SERVERS</key><string>$(SEAL_KEY_SERVERS)</string>
<key>SEAL_THRESHOLD</key><string>$(SEAL_THRESHOLD)</string>
```

`Env.swift` reads these keys and **falls back to the live MAINNET defaults** if any key is missing
or unexpanded — so a fresh checkout (no `Config.xcconfig`) still talks to mainnet + `tidalform.xyz`
out of the box.

> **xcconfig gotcha:** `//` begins a comment, which truncates URLs. Write `https:/$()/host` (an
> empty `$()` between the slashes) — already done in `Config.xcconfig.example`.

---

## Run on simulator / device

- **Simulator**: works for everything in this Lib layer (reads, sponsored submit, auth via the
  backend). Push notifications and some OAuth redirect specifics need a real device (Day 2 advanced).
- **Device**: select your iPhone, set a Signing Team, run. Sign in with Google, and you'll have a
  Sui address with **zero SUI** — submitting a form still works because gas is sponsored.

Demo tip: after a submit, show the returned **tx digest** + **Walrus blob receipt** and point out
there was **no gas prompt and no SUI** in the wallet — that's the whole pitch.

---

## The 5 end-to-end flows (source-of-truth §9)

All five are buildable on this Lib surface:

1. **A · Sign in** — UI gets a Google ID token →
   `zentos.signInWithGoogle(idToken:)` → cookie persisted in `tideformURLSession`. On launch,
   `zentos.getMe()` restores the session (throws `.notAuthenticated` on 401).

2. **B · My forms** — `indexer.listFormsForOwner(myAddress)` (queries
   `${ORIGINAL_PKG}::events::FormCreated`, filters by owner, `multiGetObjects`) → for each
   `FormObject`, `indexer.fetchFormSchema(form.schemaBlobId)` for the title.

3. **C · View / fill a form** — `indexer.fetchForm(id)` + `fetchFormSchema(schemaBlobId)` → render
   `FormSchema.allFields` by `FieldType` → collect `FieldValue`s.

4. **D · Submit (gasless, popup-less)** — assemble a `Submission` →
   `walrus.uploadJson(submission, owner: address)` (sponsored) → take `blob_id` →
   `Move.txSubmit(formId:blobId:)` → `zentos.signAndExecuteCustodial(tx:address:)`
   (serializes `onlyTransactionKind` bytes → `/api/wallet/sign`) → show digest + Walrus receipt.

5. **E · Admin inbox** — `indexer.listSubmissions(formId)` (queries `SubmissionReceived`,
   `multiGetObjects`) → `indexer.fetchSubmissionPayload(blobId)` → render. Private fields: see below.

---

## What's backend-delegated / out of scope (be honest about it)

- **Signing & gas** — never done on device. `/api/wallet/sign` co-signs as user + sponsor and
  executes. Mobile only ships base64 `txKindBytes`.
- **Sponsored Walrus uploads** — `/api/walrus/upload`. The sponsor API key never reaches the client.
- **Seal private-field DECRYPTION** — **there is no Seal SDK for Swift.** In this v1 teaching scope,
  private-field decryption is a **documented backend-delegated step** (the backend can run the
  Seal `SessionKey` + `seal_approve` PTB + key-server fetch, using `custodialSignMessage` for
  proof-of-ownership) **or is skipped**. **Public fields work fully on device.** This Lib never
  fakes encryption: `FieldValue.encrypted` carries a `SealEnvelope` whose `mode` is explicitly
  `"seal"` or `"placeholder"` — never claim placeholder mode is real encryption (source-of-truth §7).
- **Google ID token acquisition** — handled by `GoogleSignIn-iOS` in the UI layer; the Lib consumes
  the resulting token string.

---

## SuiKit VERIFY notes

`Move.swift` was written against OpenDive/SuiKit `main`. Confirmed signatures used:
`TransactionBlock()`, `object(id:)`, `pure(value: SuiJsonValue)`, `moveCall(target:arguments:…)`,
`setSenderIfNotSet(sender:)`, `build(_ provider:_ onlyTransactionKind:)`, `SuiProvider(connection:)`,
`ConnectionProtocol`, and the `SuiJsonValue` / `TransactionArgument` enums. Anything that can drift
across SuiKit versions is flagged `// VERIFY: SuiKit API`, specifically:

- **`vector<u8>` encoding** — blob IDs are pushed as `.array` of `.uint8Number` (≡ TS
  `tx.pure.vector("u8", bytes)`). Confirm your version serializes that as a BCS `vector<u8>`.
- **Object args in `moveCall`** — `tx.object(id:)` results are passed directly into
  `[TransactionArgument]`; pure inputs are wrapped with `.input(...)`. If your version returns a
  `TransactionBlockInput` from `object(id:)`, wrap object args with `.input(...)` too.
- **Provider/Connection** — a tiny `ConnectionProtocol` wrapper points SuiKit at the configured
  fullnode (needed so `build(onlyTransactionKind:)` can resolve the shared `Clock 0x6` and the
  `&mut Form` / `&mut Submission` object refs). Swap for `MainnetConnection()` etc. if your version
  ships presets.

---

## On-chain facts (Sui MAINNET, source-of-truth §2)

```
tideform package (published-at / original-id) = 0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4
Clock object                                   = 0x6 (shared)
Walrus aggregator (mainnet)                    = https://aggregator.walrus-mainnet.walrus.space
Seal key server (mainnet, threshold 1)         = 0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a
Backend (zentos)                               = https://tidalform.xyz
```

**Blob IDs are stored on-chain as `vector<u8>` of their ASCII bytes** — decode with UTF-8, never
base64 (source-of-truth §4/§12). `Indexer.decodeAsciiBlob` and `Move.pureAsciiVector` enforce this.

> For a workshop you may prefer **testnet**: set `SUI_NETWORK=testnet`, republish the package, and
> swap `TIDEFORM_PACKAGE_ID` / `TIDEFORM_ORIGINAL_PACKAGE_ID` + `WALRUS_AGGREGATOR`. Nothing is
> hard-coded beyond the fallback defaults in `Env.swift`.
