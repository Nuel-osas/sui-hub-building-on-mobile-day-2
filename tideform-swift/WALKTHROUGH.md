# Tideform · Swift (SwiftUI) — Build Walkthrough

A step-by-step guide to building the **native iOS UI layer** for Tideform on top of the
already-written `Lib/` surface. It is the Swift twin of the Expo walkthrough: every screen
here maps 1:1 to an Expo `app/` route or `components/` file, so a class can diff the two
stacks side by side.

> **Auth model (Day 2): Zentos custodial.** Native Google sign-in → `POST /api/auth/google`
> → session cookie. Privileged ops (sign, sign-message, sponsored Walrus upload) go to the
> backend. Reads (events, objects, Walrus blobs) happen **on-device** against public
> endpoints. Headline UX: **gasless + popup-less** — submitting a form prompts for zero gas
> and needs zero SUI in the wallet.

Everything below is built against the real `Lib/` APIs (`env`, `indexer`, `walrus`,
`zentos`, `Move`, and the `Schema` types). Source-of-truth references are
`docs/00-architecture-source-of-truth.md`.

---

## 0. The two layers

```
Sources/Tideform/
├─ Lib/        ← already built (the contract): env, SuiClient, Schema, Walrus, Move,
│              │  Indexer, ZentosClient. Same named surface as the Expo lib/.
├─ App/        ← THIS guide: @main entry + the session view model
│   ├─ TideformApp.swift   (@main, GoogleSignIn config, root nav + auth guard)
│   └─ AuthModel.swift      (ObservableObject: Google sign-in → ZentosClient; getMe restore)
└─ Views/      ← THIS guide: the five flows (A–E)
    ├─ LoginView.swift      (Flow A)
    ├─ MyFormsView.swift    (Flow B)
    ├─ FormFillView.swift   (Flows C + D)
    ├─ InboxView.swift      (Flow E)
    ├─ FieldView.swift      (the 14 field types — fill + read-only)
    └─ ReceiptView.swift    (Walrus + tx links; the gasless badge)
```

### Side-by-side file map (Expo ↔ Swift)

| Expo (`tideform-expo/`) | Swift (`Sources/Tideform/`) | Flow |
|---|---|---|
| `app/_layout.tsx` (router + guard) | `App/TideformApp.swift` (`RootView`) | — |
| `lib/auth.ts` (`useAuth` store) | `App/AuthModel.swift` (`@MainActor ObservableObject`) | A |
| `app/login.tsx` | `Views/LoginView.swift` | A |
| `app/index.tsx` | `Views/MyFormsView.swift` | B |
| `app/f/[id].tsx` | `Views/FormFillView.swift` | C + D |
| `app/inbox/[id].tsx` | `Views/InboxView.swift` | E |
| `components/field-renderer.tsx` | `Views/FieldView.swift` | C/E |
| `components/receipt.tsx` | `Views/ReceiptView.swift` | D |

The big diff to point out in class: the Expo store is a framework-light
`useSyncExternalStore`; the Swift one is a `@MainActor ObservableObject`. The Lib calls
they wrap (`signInWithGoogle`, `getMe`, `listFormsForOwner`, `uploadJson`, `txSubmit`,
`signAndExecuteCustodial`) are **identically named** across both.

---

## 1. Project + dependencies

Requires **Xcode 15+**, **iOS 16+** deployment target (async/await, `.task`,
`TextField(axis:)`, `.scrollDismissesKeyboard`).

1. Create a SwiftUI **App** project named `Tideform`. Add the `Lib/`, `App/`, and `Views/`
   groups to the app target ("Create groups", Target Membership checked).
2. **File ▸ Add Package Dependencies…**:

   | Package | URL | Product(s) |
   |---|---|---|
   | SuiKit (OpenDive) | `https://github.com/OpenDive/SuiKit` | `SuiKit` |
   | GoogleSignIn-iOS | `https://github.com/google/GoogleSignIn-iOS` | `GoogleSignIn`, `GoogleSignInSwift` |

   - `Lib/Move.swift` + `Lib/ZentosClient.swift` `import SuiKit`. `Views/FormFillView.swift`
     imports it once too (only to name the `TransactionBlock` returned by `Move.txSubmit`
     when handing it to the custodial signer).
   - `App/AuthModel.swift` + `App/TideformApp.swift` `import GoogleSignIn` (the UI obtains
     the ID token; the Lib's `signInWithGoogle(idToken:)` just takes the string).
   - **Pin an exact SuiKit tag/commit** — its API moves; `main` can break the build.
     `// VERIFY: SuiKit version — pin the tag you tested against`.

3. **Config → Info.plist** (see `README.md`):
   - `cp Config.xcconfig.example Config.xcconfig`, fill in `GOOGLE_CLIENT_ID`, set both
     Debug + Release to use it (Project ▸ Info ▸ Configurations).
   - Surface each build setting through Info.plist (`<key>GOOGLE_CLIENT_ID</key><string>$(GOOGLE_CLIENT_ID)</string>`, …).
     `Env.swift` reads them and falls back to live MAINNET defaults, so a fresh checkout
     still talks to mainnet + `tidalform.xyz`.
   - **Google URL Type:** add a URL Type whose **URL Scheme is the reversed client id**
     (`com.googleusercontent.apps.<NNN>-<hash>`). This is how Google calls back into the app.
   - **Audience gotcha (real):** the ID token GoogleSignIn-iOS issues has `aud` = your
     **iOS** client id. The backend `/api/auth/google` verifier must accept that client id
     as an allowed audience. `// VERIFY: backend trusts the iOS OAuth client_id as an aud`.

---

## 2. App entry + session (`TideformApp.swift` + `AuthModel.swift`)

**Mirrors:** Expo `app/_layout.tsx` (router + guard) and `lib/auth.ts` (store).

`TideformApp` does three things (just like `_layout.tsx`):

1. Configures `GIDSignIn.sharedInstance.configuration` from `env.googleClientId` (in `init`).
2. On launch, `.task { await auth.restore() }` calls `zentos.getMe()` (GET `/api/auth/me`)
   to rehydrate a persisted session. The HMAC cookie set by `/api/auth/google` lives in the
   shared cookie-aware `tideformURLSession` (disk-backed `HTTPCookieStorage`), so this
   "just works" on a cold start.
3. Routes the tree: while `auth.status` is `.idle`/`.restoring`, show a boot spinner;
   otherwise `isAuthenticated ? MyFormsView : LoginView`. Navigation to the per-form flows
   is value-based via the `Route` enum and `.navigationDestination(for: Route.self)`.

`AuthModel` is the Swift mirror of the `useAuth` store. Its `Status` mirrors the Expo
`AuthStatus` union (`idle | restoring | signingIn | authenticated | unauthenticated`):

```swift
func restore() async { /* getMe() → authenticated | unauthenticated */ }
func signIn()  async { /* fetchGoogleIdToken() → zentos.signInWithGoogle(idToken:) */ }
func signOut() async { /* zentos.signOut() + drop local state */ }
```

The one UI-presentational piece that lives here (not in the Lib) is
`fetchGoogleIdToken()` — it needs a presenting `UIViewController`:

```swift
let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: root)
return result.user.idToken?.tokenString   // → POST /api/auth/google
```

`// VERIFY: GoogleSignIn API` — the async `signIn(withPresenting:)` + `idToken.tokenString`
are confirmed on GoogleSignIn-iOS 7.x; confirm on your pinned version.

> **Teaching point:** there is **no wallet extension on a phone**. Google sign-in is the
> entire on-ramp, and the key is held by the backend (custodial). This is what lets every
> later write be gasless + popup-less.

---

## 3. Flow A — `LoginView.swift`

**Mirrors:** Expo `app/login.tsx`.

Pure presentation over `AuthModel`: brand block, three selling points (**Gasless**,
**Popup-less**, **No seed phrase**), and one button:

```swift
Button { Task { await auth.signIn() } } label: { Text("Continue with Google") }
    .disabled(!auth.ready || auth.status == .signingIn)
```

- `auth.ready` is false until `GOOGLE_CLIENT_ID` is set → the screen shows a warning instead
  of a dead button.
- A cancelled Google sheet returns to a clean `unauthenticated` state (no scary error).
- Frame the headline UX here, before the user has even signed in: *no seed phrase, no gas,
  no popups.*

---

## 4. Flow B — `MyFormsView.swift`

**Mirrors:** Expo `app/index.tsx`.

`MyFormsModel.load(address:)` is a direct call into the Lib indexer:

```swift
let forms = try await indexer.listFormsForOwner(address)   // FormCreated (ORIGINAL pkg) → multiGetObjects
for f in forms {
    let schema = try? await indexer.fetchFormSchema(f.schemaBlobId)  // Walrus read for the title
    ...
}
forms.sort { $0.createdAtMs > $1.createdAtMs }              // newest first
```

All public, on-device reads — no cookie, no backend. Each card links to **Open / fill**
(`Route.fill`) and **Inbox (n)** (`Route.inbox`). A persistent banner reminds the user that
*submissions are sponsored — 0 SUI gas, 0 popups.* Pull-to-refresh re-runs the query.

> **Pitfall to call out:** event filters use `env.originalPackageId` (type-origin is
> upgrade-stable); moveCall targets use `env.packageId`. They're equal at v1 but kept as two
> values so an upgrade doesn't silently break "my forms".

---

## 5. The 14 field types — `FieldView.swift`

**Mirrors:** Expo `components/field-renderer.tsx`.

One file, two entry points (the SwiftUI shape of field-renderer's input/readOnly modes):

- `FieldView(field:draft:locked:error:)` — interactive control bound to a `FieldDraft`.
- `FieldDisplayView(field:value:)` — read-only display of a submitted `JSONValue` (inbox).

`FieldDraft` is a small type-safe union (`text | bool | multi | rating`) that maps straight
to `FieldValue.plaintext(value: JSONValue)` at submit time (`asJSON()`), with `isEmpty` and
`defaultDraft(for:)` mirroring the Expo `isEmpty` / `defaultFor`.

All 14 types are rendered: `short_text, long_text, rich_text, dropdown, multi_select,
checkbox, rating, screenshot, video, url, number, date, email, wallet`. As in Expo, this
stage ships only SwiftUI — no native pickers — so `screenshot`/`video` accept a Walrus blob
ID or URL and `date` is a typed `YYYY-MM-DD` field (both clearly labeled; wiring
`PhotosPicker` / a graphical `DatePicker` is a documented next step).

**Private fields (the honest Swift boundary):** Swift has **no Seal SDK** (source-of-truth
§7). A `private` field in fill mode is rendered `locked` — visible but not collected — and
is omitted from the submission. We never write placeholder bytes and call them encryption.

---

## 6. Flows C + D — `FormFillView.swift` + `ReceiptView.swift`

**Mirrors:** Expo `app/f/[id].tsx` + `components/receipt.tsx`. This is the heart of the
custodial model.

**C (view):**

```swift
let f = try await indexer.fetchForm(formId)
let s = try await indexer.fetchFormSchema(f.schemaBlobId)
// render s.allFields by type via FieldView; seed FieldDraft defaults
```

**D (submit) — gasless, popup-less:** exactly the four steps from §9.D, only two of which
leave the device (the two needing a server-held secret):

```swift
// 1. assemble Submission.fields (public fields only on iOS v1)
var fields: [String: FieldValue] = [:]
for field in fields where !field.isPrivate {
    guard let d = values[field.id], !d.isEmpty else { continue }
    fields[field.id] = .plaintext(value: d.asJSON())
}
let submission = Submission(formId:, formVersion: schema.formVersion,
                            submittedAt: ISO8601…, submitter: address, fields: fields)

// 2. SPONSORED Walrus upload → blob_id  (cookie carries the session)
let upload = try await walrus.uploadJson(submission, owner: address)

// 3. build submission::submit PTB → backend signs as sender + sponsor, executes
let tx = try Move.txSubmit(formId: formId, blobId: upload.blobId)
let res = try await zentos.signAndExecuteCustodial(tx: tx, address: address)

// 4. surface the receipt (tx digest + Walrus blob) and the gasless badge
```

`signAndExecuteCustodial(tx:address:)` internally does `setSenderIfNotSet` →
`build(onlyTransactionKind: true)` → base64 → `POST /api/wallet/sign`. The
`build(onlyTransactionKind:)` call is the **most uncertain SuiKit surface** — it is
`// VERIFY: SuiKit API` in `Lib/Move.swift`. Everything downstream (the POST, cookie,
response shape `{ digest, sponsorAddress, senderAddress }`) is exact.

`ReceiptView` deep-links the **tx digest** (SuiVision) and the **Walrus blob** (Walruscan +
the raw aggregator via `walrus.blobUrl`), network-aware from `env.network`, and shows the
badge: **0 SUI gas · 0 popups · sponsored by Zentos**.

> **Encoding rule (the #1 pitfall):** the blob ID is stored on-chain as `vector<u8>` of its
> **ASCII bytes** (`Move.txSubmit` does `Array(blobId.utf8)`), never base64. `Indexer`
> decodes the same way (UTF-8). Don't `Data(base64Encoded:)` a blob ID.

---

## 7. Flow E — `InboxView.swift`

**Mirrors:** Expo `app/inbox/[id].tsx`.

```swift
let subs = try await indexer.listSubmissions(formId)        // SubmissionReceived → multiGetObjects
for obj in subs { let payload = try await indexer.fetchSubmissionPayload(obj.blobId) }  // Walrus reads
```

Each submission card shows on-chain status/priority/tags + the payload fields, rendered with
the form schema via `FieldDisplayView`. Per-field handling:

- **plaintext** → shown directly (type-aware).
- **media / encrypted-media** → blob id + link to the raw aggregator.
- **encrypted (placeholder)** → base64-decoded and clearly labeled *"not encrypted"*.
- **encrypted (seal)** → labeled **backend-delegated**. Swift has **no Seal SDK**, so there
  is no on-device decrypt button here. The proof-of-ownership signature exists
  (`zentos.custodialSignMessage` → `/api/wallet/sign-message`), but with no Seal client to
  consume it, decryption is a documented backend step or a web-admin action. **We never fake
  it.** (This is the deliberate contrast with the Expo inbox, which best-effort decrypts when
  WebCrypto is present.)

Admin detection: `form.owner == me || form.admins.contains(me)` (lowercased compare). Non-
admins see public fields and a notice that private fields are admin-only.

---

## 8. Run it + the gasless demo

- **Simulator** covers everything here (reads, sponsored submit, custodial auth).
- **Device:** set a Signing Team, run, sign in with Google. You now have a Sui address with
  **zero SUI** — submitting a form still works because gas is sponsored.

**Demo script (the whole pitch in 30 seconds):**
1. Sign in with Google — no seed phrase, no extension.
2. Open a form, fill the public fields, tap **Submit · gasless**.
3. On the receipt, tap **Tx digest** (SuiVision) and **Walrus blob** (Walruscan).
4. Point out: **no gas prompt, no wallet popup, 0 SUI in the wallet.** The Zentos backend
   sponsored and co-signed the transaction.

---

## 9. VERIFY checklist (don't trust silently)

- **SuiKit version** — pin the tag you tested. `main` drifts.
- **`build(onlyTransactionKind:)`** — the custodial signer's serialization step
  (`Lib/Move.swift`). If your SuiKit lacks the flag, hand-build the TransactionKind BCS and
  use `zentos.signAndExecuteCustodial(kindBytesBase64:address:)` — the HTTP contract is exact.
- **`tx.pure(value: .array(.uint8Number…))`** serializing as BCS `vector<u8>` (the ASCII
  blob-id encoding). Confirm against your version.
- **GoogleSignIn** — async `signIn(withPresenting:)`, `result.user.idToken?.tokenString`,
  and the `.canceled` error (domain `com.google.GIDSignIn`, code `-5`).
- **Backend `aud`** — `/api/auth/google` must trust your **iOS** OAuth client id.

## 10. Troubleshooting

- **Cookie not sent / 401 on submit** → some call used `URLSession.shared` instead of the
  shared `tideformURLSession`. Every privileged call must ride the one cookie-aware session
  (Lib already wires this; don't introduce a second session in the UI).
- **Empty "My Forms"** → wrong package id in the event filter (must be
  `env.originalPackageId`), or the form's owner ≠ the signed-in address.
- **Garbled blob ID** → you base64-decoded an ASCII `vector<u8>`. Decode as UTF-8.
- **u64 decode crash** → `submitted_at_ms` / `version` arrive as quoted strings; the Lib's
  `JSONValue.uint64Value` already handles this — use the Lib models, don't re-decode raw.
- **"Seal works on iOS"** → it doesn't (no Swift SDK). Encrypted output you see is either a
  labeled placeholder or ciphertext you cannot open on-device. Public fields only in v1.
```
