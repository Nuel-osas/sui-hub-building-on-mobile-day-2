# Building on Mobile · Day 2 — The Kit Class

Companion repo for **Day 2 of the SuiHub Lagos Mobile Workshop**: taking a real, live Sui
app — **Tideform** (a Walrus-native forms platform, live at **tidalform.xyz**) — and putting
it on a phone. Twice: once in **Expo** (iOS + Android), once in native **Swift** (iOS).

> **The one idea of the day:** going mobile is *not* rewriting your app. It's building a thin
> native client over a backend you already have. Auth, custodial signing, gas sponsorship, and
> Walrus uploads stay on the **Zentos** backend. The phone calls them. Reads (forms, submissions,
> Walrus blobs) happen directly on the device. The result is **gasless, popup-less, no-extension**
> mobile UX.

---

## What's in here

| Path | What it is |
|---|---|
| [`docs/00-architecture-source-of-truth.md`](docs/00-architecture-source-of-truth.md) | The ground truth — exact mainnet IDs, Move targets, endpoint contracts, schema types, the shared mobile lib surface. Read this first. |
| [`docs/01-web-to-mobile-map.md`](docs/01-web-to-mobile-map.md) | Maps every piece of the Tideform web app to its mobile equivalent — what moves to the device, what stays on the backend, and why. |
| [`docs/02-zentos-and-sponsorship.md`](docs/02-zentos-and-sponsorship.md) | How the custodial + gas-sponsored model works end-to-end from a phone. |
| [`docs/03-auth-models-day1-vs-day2.md`](docs/03-auth-models-day1-vs-day2.md) | Day 1 zkLogin (non-custodial) vs Day 2 Zentos custodial — the honest trade-off and when to pick each. |
| [`tideform-expo/`](tideform-expo/) | The Expo (iOS + Android) port. Runnable app + `README` + `WALKTHROUGH`. |
| [`tideform-swift/`](tideform-swift/) | The native SwiftUI (iOS) port. Same five flows + `README` + `WALKTHROUGH`. |
| [`skills/expo-sui/`](skills/expo-sui/) | The reusable Claude skill for building Sui apps in Expo. |
| [`skills/swift-sui/`](skills/swift-sui/) | The reusable Claude skill for building native Sui apps in Swift. |
| [`slides/Day2_Kit_Class.pptx`](slides/) | The workshop deck. |

---

## The two apps — same app, two stacks

Both apps implement the **same five flows** and expose the **same `lib/` API surface**, so you
can read them side by side and see the shape match line for line.

| Flow | What happens | Where |
|---|---|---|
| **A · Sign in** | Native Google sign-in → ID token → `POST /api/auth/google` → session + Sui address | backend |
| **B · My forms** | Query `FormCreated` events for your address → fetch schemas from Walrus | on-device |
| **C · Fill a form** | Read the Form object + schema → render the 14 field types | on-device |
| **D · Submit** | Upload JSON to Walrus (sponsored) → `submission::submit` (custodial sign) | mix |
| **E · Inbox** | Query `SubmissionReceived` → fetch payloads → triage | on-device |

The headline moment in the demo: **submit a form and point out there was no gas prompt, no wallet
popup, and no extension installed.** That's the custodial + sponsored model doing its job.

### The shared `lib/` contract

| Concern | Functions |
|---|---|
| Config / client | `env`, `suiClient` |
| Reads | `listFormsForOwner`, `fetchForm`, `fetchFormSchema`, `listSubmissions`, `fetchSubmissionPayload` |
| Walrus | `readBlob`, `readJson`, `uploadBlob`, `uploadJson`, `blobUrl` |
| Move tx builders | `txCreateForm`, `txSubmit`, `txSetFormStatus`, `txSubmissionStatus`, `txAttachNotes`, `txAddTag` |
| Auth (Zentos) | `signInWithGoogle`, `getMe`, `signOut` |
| Sign (Zentos) | `signAndExecuteCustodial`, `custodialSignMessage` |
| Types | `FieldType`, `Field`, `FormSchema`, `Submission`, `FieldValue` |

---

## Run it

### Expo (iOS + Android)
```bash
cd tideform-expo
cp .env.example .env        # mainnet defaults are filled in; add your Google client ID
npm install
npm start                   # scan the QR with Expo Go, or run on a simulator
```
See [`tideform-expo/README.md`](tideform-expo/README.md) and
[`tideform-expo/WALKTHROUGH.md`](tideform-expo/WALKTHROUGH.md).

### Swift (iOS)
Open the project in Xcode, add **SuiKit** and **GoogleSignIn-iOS** via Swift Package Manager,
copy `Config.xcconfig.example` → `Config.xcconfig`, set your Google client ID, and run on a
device or simulator. See [`tideform-swift/README.md`](tideform-swift/README.md) and
[`tideform-swift/WALKTHROUGH.md`](tideform-swift/WALKTHROUGH.md).

> **Backend:** both apps default `BACKEND_BASE_URL` to the live `https://tidalform.xyz`, so reads
> and the custodial flows work out of the box. Point it at a self-hosted Zentos instance to run
> the whole stack yourself.

---

## The kit — two Claude skills

The reusable takeaway from today. Install once and every future Claude session scaffolds a Sui
mobile app the same correct way:

```bash
cp -R skills/expo-sui  ~/.claude/skills/expo-sui
cp -R skills/swift-sui ~/.claude/skills/swift-sui
```

- **`expo-sui`** — triggers on "build a Sui mobile app in Expo". Native Google sign-in, on-device
  reads, custodial + sponsored signing, plus a Day-1 zkLogin login screen.
- **`swift-sui`** — the native iOS mirror. SuiKit + GoogleSignIn-iOS, URLSession JSON-RPC reads,
  transaction-kind bytes → `/api/wallet/sign`, with an honest Seal boundary.

---

## Honesty notes (read before the demo)

- **Custodial = centralized, by design.** The server holds an AES-encrypted key and signs on the
  user's behalf. For consumer onboarding that's the win — no seed phrase, no extension, no gas, no
  popups — and it's bounded by `POST /api/wallet/export`, which hands the user a `suiprivkey1…` so
  they can leave to self-custody whenever they want.
- **Reads need no backend.** Querying events, objects, and Walrus blobs works straight from the phone.
- **Blob IDs are ASCII `vector<u8>` on-chain** — decode as UTF-8, never base64.
- **Seal (private fields):** best-effort in Expo (RN crypto polyfills), documented backend-delegated
  boundary in Swift (no Seal Swift SDK). Public fields work fully on both. Placeholder mode is never
  claimed to be real encryption.
- A handful of SDK-version-sensitive calls (SuiKit transaction builder, GoogleSignIn nonce, the
  `@mysten/seal` version pin) are marked `// VERIFY` rather than guessed — pin your versions and confirm.

---

## Credits

Built by [@minting_ruru](https://x.com/minting_ruru) for the SuiHub Lagos Mobile Workshop.
Day 1 (zkLogin foundations): [Sui-hub--building-on-mobile-day-1](https://github.com/Nuel-osas/Sui-hub--building-on-mobile-day-1).

## License

Apache-2.0.
