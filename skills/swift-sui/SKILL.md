---
name: swift-sui
description: >-
  Use when building a native SwiftUI iOS app on Sui. Triggers: "build a Sui iOS app
  in Swift", "swiftui sui zklogin", "native sui ios", "swift sui wallet", "ios sui
  gasless transaction", "swift custodial sui sign", "swiftui walrus upload", "port my
  Sui dApp to native iOS". This is the Swift mirror of the expo-sui skill: same lib
  surface (env / suiClient / indexer / walrus / move / zentos / schema), but with
  SuiKit + GoogleSignIn-iOS instead of the JS SDKs. Teaches both auth models (Day-1
  on-device zkLogin and Day-2 custodial Zentos backend), gasless + popup-less signing,
  on-device reads, and where SuiKit is too immature to trust.
tools: Read, Glob, Grep, Bash, Write, Edit
---

# swift-sui — native SwiftUI iOS apps on Sui

You are building a **native iOS app (Swift + SwiftUI)** that talks to **Sui mainnet**
and to the **Tideform / Zentos** backend. This skill is the Swift twin of `expo-sui`.
The two stacks expose the **same named `lib` surface** (see §"The Lib surface") so a
class can diff Expo `lib/` against Swift `Lib/` line for line.

The architecture ground-truth lives at
`day2-repo/docs/00-architecture-source-of-truth.md`. **Read it before generating code.**
Every on-chain ID, endpoint path, Move target, and type shape comes from there — never
invent them. If a value is not in that doc or derivable from it, emit a
`// VERIFY: <what to confirm>` marker instead of guessing.

---

## When to activate

Activate this skill when the user wants a **native iOS / SwiftUI** client on Sui —
keypairs/address, JSON-RPC reads, building transactions, signing, Walrus, Google sign-in.
If they want React Native / cross-platform, use **expo-sui** instead. If they want web,
use the web Tideform/Zentos code directly.

## Honesty rules (do not skip)

1. **SuiKit (`github.com/opendive/suikit`) is the only real Swift Sui SDK, and it is
   not at parity with `@mysten/sui`.** Use it for keypairs, address derivation, BCS, and
   JSON-RPC where it is solid. For anything you are not certain of — especially the
   transaction-builder API and `onlyTransactionKind` BCS output — write the call and
   tag it `// VERIFY: SuiKit API`. Do **not** fabricate method names. When in doubt,
   fall back to hand-rolled `URLSession` JSON-RPC (always works) and document it.
2. **Blob IDs are stored on-chain as ASCII `vector<u8>`** (`TextEncoder().encode(id)` on
   web). Decode them as **UTF-8**, never base64. In Swift: `[UInt8](blobId.utf8)` to
   encode, `String(decoding: Data(bytes), as: UTF8.self)` to decode.
3. **There is no Seal SDK for Swift.** Private-field encrypt/decrypt cannot run on-device.
   v1 Swift apps handle **public fields only**; private fields are a documented
   backend-delegated boundary or out of scope. Never call placeholder bytes "encryption".
4. **Gasless + popup-less is the headline UX.** Preserve it and surface it in the UI:
   after a custodial submit, show the tx digest and the Walrus receipt and explicitly
   tell the user "0 SUI, 0 popups."

---

## The two auth models (and when to pick each)

| | **Day-1 — on-device zkLogin** | **Day-2 — custodial Zentos (this skill's default)** |
|---|---|---|
| Key custody | ephemeral key on device + ZK proof | server-held key (AES-256-GCM in Postgres), exportable |
| Signing | device builds + signs, prover round-trip | device builds tx-kind bytes, **backend signs + sponsors** |
| Gas | user needs SUI (unless separately sponsored) | **sponsor pays — user holds 0 SUI** |
| Popups | none, but heavy crypto on device | none |
| Swift maturity | rough — SuiKit zkLogin support is partial (nonce, proof, address all `// VERIFY`) | **clean — it's just an HTTPS client over §6 routes** |
| Use when | you need true non-custodial, no backend | you want the simplest, shippable mobile app (recommended) |

**Pick custodial Zentos for almost every mobile app.** It removes the wallet extension
(which does not exist on a phone), removes gas, and removes the entire prover/salt
pipeline. The device becomes a thin, native client over the §6 HTTP endpoints. The
zkLogin path is preserved as a Day-1 mirror in `references/quickstart.md` for teaching
the contrast — but it is where SuiKit is least mature, so it is heavily `// VERIFY`-marked.

> The decentralized-zkLogin module (salt on Walrus, gated by an on-chain `seal_approve`
> that verifies a Google JWT, proven by a self-hosted GPU prover) is the bridge that
> fuses both. It is out of scope for v1 Swift — point at
> `zentos/docs/decentralized-zklogin.md`.

---

## Project setup (Xcode + SwiftUI)

1. **Xcode 15+**, new **App** project, interface **SwiftUI**, language **Swift**, min
   iOS 16 (async/await + `.task`/`onChange` ergonomics). Bundle ID must match the one you
   register for Google OAuth.
2. **Add packages** (File ▸ Add Package Dependencies):
   - SuiKit — `https://github.com/opendive/suikit.git`, product **`SuiKit`**.
     Pin an exact version/commit; SuiKit's API moves and `main` can break the build.
     `// VERIFY: SuiKit version — pin the tag you tested against`.
   - GoogleSignIn-iOS — `https://github.com/google/GoogleSignIn-iOS`, products
     **`GoogleSignIn`** and **`GoogleSignInSwift`**.
3. **Info.plist for Google**:
   - Add `GIDClientID` = your iOS OAuth client ID
     (`<NNN>-<hash>.apps.googleusercontent.com`).
   - Add a URL Type whose **URL Scheme is the reversed client ID**
     (`com.googleusercontent.apps.<NNN>-<hash>`). This is how Google calls back into the app.
   - Network calls to `*.sui.io`, `*.walrus.space`, and `tidalform.xyz` are plain HTTPS —
     no ATS exception needed.
4. **Suggested file layout** (mirrors Expo `lib/`):

```
App/
  TideformApp.swift          // @main, GIDSignIn URL handling, injects AppState
  AppState.swift             // @MainActor ObservableObject: session, current user
Lib/
  Env.swift                  // env: ids, endpoints, network  (this file, below)
  SuiRPC.swift               // suiClient: URLSession JSON-RPC  (references/suikit.md)
  Indexer.swift              // listFormsForOwner / fetchForm / ...  (references/suikit.md)
  Walrus.swift               // readBlob / uploadBlob / blobUrl  (this file, below)
  Move.swift                 // txCreateForm / txSubmit / ...  (references/suikit.md)
  Zentos.swift               // ZentosClient auth + sign  (references/zentos-backend.md)
  Schema.swift               // FieldType / Field / FormSchema / Submission / FieldValue  (references/patterns.md)
Features/
  LoginView.swift            // zkLogin demo screen  (references/quickstart.md)
  FormsListView.swift        // "my forms"
  FillFormView.swift         // render schema → submit
```

---

## The Lib surface (must match expo-sui exactly)

| Concern | Symbols | Lives in |
|---|---|---|
| Env/config | `Env.network, .packageId, .originalPackageId, .walrusAggregator, .backendBaseUrl, .googleClientId, .sealKeyServers, .sealThreshold` | `Env.swift` (below) |
| Sui client | `SuiRPC` (`suiClient`) | `references/suikit.md` |
| Reads | `Indexer.listFormsForOwner(_:)`, `.fetchForm(_:)`, `.fetchFormSchema(_:)`, `.listSubmissions(_:)`, `.fetchSubmissionPayload(_:)` | `references/suikit.md` |
| Walrus | `Walrus.readBlob(_:)`, `.readJson(_:as:)`, `.uploadBlob(_:owner:)`, `.uploadJson(_:owner:)`, `.blobUrl(_:)` | this file |
| Move builders | `Move.txCreateForm`, `.txSubmit`, `.txSetFormStatus`, `.txSubmissionStatus`, `.txSubmissionPriority`, `.txAttachNotes`, `.txAddTag` | `references/suikit.md` |
| Auth | `ZentosClient.signInWithGoogle(idToken:)`, `.getMe()`, `.signOut()` | `references/zentos-backend.md` |
| Sign | `ZentosClient.signAndExecuteCustodial(_:address:)`, `.custodialSignMessage(_:)` | `references/zentos-backend.md` |
| Schema/types | `FieldType`, `Field`, `FormSchema`, `Submission`, `FieldValue` | `references/patterns.md` |

---

## `Lib/Env.swift` — the canonical config (mainnet values from the source of truth)

```swift
import Foundation

enum SuiNetwork: String { case mainnet, testnet }

/// Mirror of expo-sui `lib/env.ts`. All IDs are read straight from
/// docs/00-architecture-source-of-truth.md §2/§5/§7. Override at runtime via env vars
/// so the same binary can point at testnet or a self-hosted Zentos.
enum Env {
    static let network: SuiNetwork =
        SuiNetwork(rawValue: ProcessInfo.processInfo.environment["SUI_NETWORK"] ?? "mainnet") ?? .mainnet

    /// `published-at` — used for moveCall **targets**.
    static let packageId =
        "0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4"

    /// `original-id` — used for **event type-origin** queries (never changes on upgrade).
    static let originalPackageId =
        "0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4"

    static var walrusAggregator: String {
        network == .mainnet
            ? "https://aggregator.walrus-mainnet.walrus.space"
            : "https://aggregator.walrus-testnet.walrus.space"
    }

    /// Defaults to the live Tideform/Zentos backend so the app works out of the box;
    /// override with ZENTOS_BACKEND_URL for a self-hosted instance or localhost.
    static let backendBaseUrl =
        ProcessInfo.processInfo.environment["ZENTOS_BACKEND_URL"] ?? "https://tidalform.xyz"

    /// iOS OAuth client ID from Google Cloud console (also set as GIDClientID in Info.plist).
    static let googleClientId =
        ProcessInfo.processInfo.environment["GOOGLE_IOS_CLIENT_ID"]
        ?? "<YOUR_IOS_OAUTH_CLIENT_ID>.apps.googleusercontent.com" // VERIFY: your Google Cloud iOS client id

    /// Mainnet Seal key server (free, public). Swift cannot use Seal yet (no SDK) —
    /// kept for parity with the Lib surface; see the Seal boundary section.
    static let sealKeyServers =
        ["0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a"]
    static let sealThreshold = 1

    static var fullnodeURL: URL {
        network == .mainnet
            ? URL(string: "https://fullnode.mainnet.sui.io:443")!
            : URL(string: "https://fullnode.testnet.sui.io:443")!
    }

    static let clockObjectId = "0x6"
}
```

---

## Native Google sign-in → ID token

The whole auth flow starts by getting a **Google ID token** on-device, then POSTing it
to `/api/auth/google` (custodial) — or using it as the JWT in the zkLogin pipeline (Day-1).
GoogleSignIn-iOS yields the token; everything Sui-specific happens after.

```swift
// App/TideformApp.swift
import SwiftUI
import GoogleSignIn

@main
struct TideformApp: App {
    @StateObject private var app = AppState()

    init() {
        GIDSignIn.sharedInstance.configuration =
            GIDConfiguration(clientID: Env.googleClientId)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .onOpenURL { url in
                    GIDSignIn.sharedInstance.handle(url) // OAuth callback (reversed-client-id scheme)
                }
                .task { await app.restoreSession() }     // GET /api/auth/me on launch
        }
    }
}
```

```swift
// Get the ID token. Must run on the main actor with a presenting UIViewController.
import GoogleSignIn
import UIKit

@MainActor
func fetchGoogleIdToken() async throws -> String {
    guard let root = UIApplication.shared.connectedScenes
        .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
        .first
    else { throw AuthError.noPresenter }

    let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: root)
    guard let idToken = result.user.idToken?.tokenString else {
        throw AuthError.noIdToken
    }
    return idToken
}
```

> **Audience gotcha (real, document it):** the ID token GoogleSignIn-iOS issues has
> `aud` = your **iOS** client ID, not the web client ID. The backend's
> `/api/auth/google` verifier must accept the iOS client ID as an allowed audience
> (or you pass `serverClientID` to also obtain a backend-audience token).
> `// VERIFY: backend trusts the iOS OAuth client_id as an allowed aud`. Default scopes
> `openid email` are sufficient — that is all `/api/auth/google` needs.

Then hand the token to the auth client (full client in `references/zentos-backend.md`):

```swift
let user = try await ZentosClient.shared.signInWithGoogle(idToken: idToken)
app.user = user   // { address, email, name, picture, isNew }
```

---

## URLSession + HTTPCookieStorage — the session cookie

`/api/auth/google` returns an **HttpOnly HMAC session cookie**. Unlike Expo's `fetch`,
a `URLSession` configured with `HTTPCookieStorage` persists and re-sends cookies
automatically — so every later privileged call (`/api/wallet/sign`, `/api/walrus/upload`,
`/api/auth/me`) is authenticated for free. Use **one shared session everywhere** so they
share the cookie jar.

```swift
// Defined in references/zentos-backend.md, reused by Walrus uploads and all backend calls.
enum ZentosSession {
    static let shared: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = .shared          // persists the Set-Cookie across launches
        cfg.httpCookieAcceptPolicy = .always
        cfg.httpShouldSetCookies = true
        return URLSession(configuration: cfg)
    }()
}
```

`HTTPCookieStorage.shared` is process-wide and disk-backed; the cookie survives app
relaunch, which is why `restoreSession()` (a plain `GET /api/auth/me`) just works on
the next cold start. (If you need cookie state scoped per-user or cleared on sign-out,
call `signOut()` which hits `/api/auth/logout` and the backend clears it.)

---

## Reads happen on-device (no backend) — events, objects, Walrus

Querying events, fetching objects, and reading Walrus blobs all hit **public** endpoints
directly from the phone. No cookie, no backend. This is `SuiRPC` (the `suiClient`) +
`Indexer` + `Walrus`. Full JSON-RPC client and the `Indexer` (`listFormsForOwner`,
`fetchForm`, `fetchFormSchema`, `listSubmissions`, `fetchSubmissionPayload`) are in
`references/suikit.md`; the Move-struct field decoding rules (including ASCII
`vector<u8>` blob IDs) are in `references/patterns.md`.

The read pipeline for "my forms" (flow B in the source of truth):
1. `suix_queryEvents` with `MoveEventType = "\(Env.originalPackageId)::events::FormCreated"`.
2. Keep events whose `parsedJson.owner == myAddress`.
3. `sui_multiGetObjects` on the collected `form_id`s, `options.showContent = true`.
4. For each, UTF-8-decode `schema_blob_id` (a `[UInt8]` array) → Walrus blob ID →
   `Walrus.readJson` the `FormSchema`.

---

## `Lib/Walrus.swift` — reads on-device, writes sponsored via backend

```swift
import Foundation

struct WalrusUploadResult: Decodable {
    let blob_id: String            // <-- this is what you store on-chain
    let sponsored_blob_id: String?
    let tx_digest: String?
    let end_epoch: Int?
    let wal_cost: Int?
}

enum Walrus {
    /// Public aggregator read — works from any phone, no auth.
    static func blobUrl(_ id: String) -> URL {
        URL(string: "\(Env.walrusAggregator)/v1/blobs/\(id)")!
    }

    static func readBlob(_ id: String) async throws -> Data {
        let (data, resp) = try await URLSession.shared.data(from: blobUrl(id))
        try Http.check(resp, data)
        return data
    }

    static func readJson<T: Decodable>(_ id: String, as type: T.Type) async throws -> T {
        try JSONDecoder().decode(T.self, from: await readBlob(id))
    }

    /// Sponsored write: multipart POST to the app's own backend, which forwards to the
    /// Krilly sponsor with a server-only API key. User pays 0 WAL / 0 SUI.
    /// Returns `blob_id` — the value you put on-chain.
    static func uploadBlob(_ bytes: Data, owner: String,
                           epochs: Int = 5, deletable: Bool = true) async throws -> WalrusUploadResult {
        let url = URL(string: "\(Env.backendBaseUrl)/api/walrus/upload")!
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
            body.append("\(value)\r\n")
        }
        // file part
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"blob.bin\"\r\n")
        body.append("Content-Type: application/octet-stream\r\n\r\n")
        body.append(bytes)
        body.append("\r\n")
        // text parts (exact field names from §5)
        field("creator_address", owner)
        field("epochs", String(epochs))
        field("deletable", deletable ? "true" : "false")
        body.append("--\(boundary)--\r\n")
        req.httpBody = body

        // ZentosSession carries the session cookie set by /api/auth/google.
        let (data, resp) = try await ZentosSession.shared.data(for: req)
        try Http.check(resp, data)
        return try JSONDecoder().decode(WalrusUploadResult.self, from: data)
    }

    static func uploadJson<T: Encodable>(_ obj: T, owner: String) async throws -> WalrusUploadResult {
        let data = try JSONEncoder().encode(obj)
        return try await uploadBlob(data, owner: owner)
    }
}

private extension Data {
    mutating func append(_ s: String) { append(Data(s.utf8)) }
}

enum Http {
    static func check(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw NSError(domain: "Http", code: code,
                userInfo: [NSLocalizedDescriptionKey: String(decoding: data, as: UTF8.self)])
        }
    }
}
```

---

## Build transaction-kind bytes → POST `/api/wallet/sign` (gasless, popup-less)

This is the heart of the custodial model (flow D). The device builds **only the
transaction kind** (no gas, no sender signature), base64-encodes it, and POSTs it. The
backend sets the sponsor as gas owner, signs as both sender and sponsor, executes, and
returns the digest. A Move-target allowlist on the server stops the sponsor being drained.

```swift
// Submit a form payload, fully gasless. Move builders + ZentosClient are in the references.
func submitForm(formId: String, payload: Submission, ownerAddress: String) async throws -> SignResult {
    // 1. upload the submission JSON to Walrus (sponsored) → blob_id
    let up = try await Walrus.uploadJson(payload, owner: ownerAddress)

    // 2. build the submission::submit PTB (blob_id encoded as ASCII vector<u8>)
    var tx = try Move.txSubmit(formId: formId, blobId: up.blob_id)   // see references/suikit.md

    // 3. setSender + build(onlyTransactionKind) + base64 + POST /api/wallet/sign
    let result = try await ZentosClient.shared.signAndExecuteCustodial(&tx, address: ownerAddress)

    // 4. surface the gasless story
    print("✅ tx \(result.digest) — sponsored by \(result.sponsorAddress). 0 SUI, 0 popups.")
    return result   // { digest, sponsorAddress, senderAddress }
}
```

`signAndExecuteCustodial` mirrors web's `lib/signer.ts`: `tx.setSender(address)` →
`tx.build(onlyTransactionKind: true)` → base64 → `POST /api/wallet/sign { txKindBytes }`.
The `build(onlyTransactionKind:)` call is the **most uncertain SuiKit surface** — it is
`// VERIFY: SuiKit API` in `references/zentos-backend.md` and `references/suikit.md`, with
a fallback. Everything downstream (the HTTP POST, cookie, response shape) is exact.

**Surface gasless in the UI**, every time:

```swift
// after a successful submit
Text("Submitted on-chain — you paid 0 SUI and saw 0 wallet popups.")
Link("View transaction", destination: URL(string: "https://suiscan.xyz/mainnet/tx/\(result.digest)")!)
Link("Walrus receipt", destination: Walrus.blobUrl(up.blob_id))
```

---

## Sponsored Walrus upload (recap)

`Walrus.uploadBlob` / `uploadJson` (above) are the sponsored write path. The client never
sees `WALRUS_SPONSOR_API_KEY`; the backend holds it and forwards to the Krilly sponsor.
The returned `blob_id` is the on-chain value (it goes into `form::create`'s
`schema_blob_id` or `submission::submit`'s `blob_id`, encoded as ASCII `vector<u8>`).

---

## Seal / private fields — documented boundary (no Swift SDK)

**There is no Seal SDK for Swift.** This is a hard boundary, not a TODO:

- **Encrypt on submit:** cannot run on-device. A v1 Swift app submits **public fields
  only** (`FieldValue.plaintext` / `.media`). For a field marked `private`, either skip it
  in v1 or post the raw value to a backend route that performs the Seal encryption
  server-side. **No such route exists in the documented §6 surface — adding one is an app
  decision; mark it `// VERIFY: backend Seal-encrypt route (not in §6)`.** Never write
  placeholder bytes and call them encryption.
- **Decrypt in admin inbox:** also has no Swift path. The Seal decrypt flow needs
  `client.decrypt({ data, sessionKey, txBytes })`, which is browser/Node only. The one
  piece Swift *can* provide is the proof-of-ownership signature
  (`ZentosClient.custodialSignMessage` → `/api/wallet/sign-message`), but without a Seal
  client there is nothing to feed it into. So: private-field decryption is
  **backend-delegated or out of v1 scope**.
- **Public fields work fully** on Swift — reads, schema render, submit, on-chain triage
  (status/priority/tags/notes) all function end to end.

```swift
// Lib/Seal.swift — explicit, labeled boundary so the gap is visible in code, not silent.
enum Seal {
    /// No Seal SDK exists for Swift. v1 = public fields only. To support private fields,
    /// route the value through a server-side Seal step.
    static func encryptField(_ plaintext: Data, sealId: String) throws -> Never {
        fatalError("Seal has no Swift SDK — backend-delegated or out of v1 scope (see SKILL.md).")
        // VERIFY: backend Seal-encrypt route (not part of docs §6)
    }
}
```

---

## References

- `references/quickstart.md` — minimal **zkLogin** login screen in SwiftUI (Day-1 mirror).
- `references/zentos-backend.md` — the §6 endpoints + `ZentosClient`
  (`signInWithGoogle`, `getMe`, `signOut`, `signAndExecuteCustodial`,
  `custodialSignMessage`) with full URLSession cookie handling.
- `references/suikit.md` — SuiKit usage: `SuiRPC` client, JSON-RPC reads, `Indexer`,
  building a PTB / transaction-kind bytes (with `// VERIFY: SuiKit API` where uncertain).
- `references/patterns.md` — do/don't, JSON-RPC reads of Move structs in Swift, ASCII
  `vector<u8>` blob IDs, the `Schema` types, and the common pitfalls.
