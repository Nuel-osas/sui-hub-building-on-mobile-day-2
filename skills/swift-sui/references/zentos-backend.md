# Zentos backend — Swift `ZentosClient`

Zentos is "custodial Google → Sui wallet for apps." The Swift app does **not** rebuild
auth/signing/gas — it is a native HTTPS client over the exact same routes the web uses.
All routes are relative to `Env.backendBaseUrl` (defaults to `https://tidalform.xyz`,
env-overridable via `ZENTOS_BACKEND_URL`).

This file is the Swift mirror of the zentos web client (`lib/zentos.ts` + `lib/signer.ts`)
and matches the Lib surface: `signInWithGoogle`, `getMe`, `signOut`,
`signAndExecuteCustodial`, `custodialSignMessage`.

---

## The endpoints (source of truth §6)

### Auth (§6.1)

| Route | Body | Returns |
|---|---|---|
| `POST /api/auth/google` | `{ idToken }` (Google ID-token JWT) | `{ address, email, name, picture, isNew }` + sets HMAC session cookie |
| `GET  /api/auth/me` | — (cookie) | `{ address, email, name, picture, isExported }` or `401` |
| `POST /api/auth/logout` | — | clears cookie |

First sign-in mints an `Ed25519Keypair`, AES-256-GCM-encrypts the secret, stores it in
Postgres keyed by the Google `sub`. **Same Google account → same Sui address forever.**

### Signing — custodial + sponsored (§6.2)

| Route | Body | Returns |
|---|---|---|
| `POST /api/wallet/sign` | `{ txKindBytes }` (base64 of `tx.build({ onlyTransactionKind: true })`) | `{ digest, sponsorAddress, senderAddress }` |
| `POST /api/wallet/sign-message` | `{ message }` (base64 bytes) | `{ signature, address }` |
| `POST /api/wallet/export` | — | Bech32 `suiprivkey1…` (self-custody escape hatch) |

- `/api/wallet/sign`: server decrypts the key in-memory, sets the sponsor as gas owner,
  signs as **both** sender (user) and sponsor, executes. **User pays 0 SUI, sees 0 popups.**
  A Move-target allowlist prevents draining the sponsor with arbitrary PTBs — only
  Tideform/Zentos targets are honored.
- `/api/wallet/sign-message`: signs a personal message with the custodial key. This is
  what Seal's `SessionKey` flow needs; on mobile it replaces the wallet-popup
  `signPersonalMessage`. (Swift has no Seal client to consume the result — see the Seal
  boundary in `SKILL.md`. The method is provided for parity and for any backend-delegated
  Seal flow.)

---

## Shared session (one cookie jar for the whole app)

```swift
import Foundation

/// One URLSession for every backend call so they share the HMAC session cookie that
/// /api/auth/google sets. HTTPCookieStorage.shared is disk-backed, so the cookie
/// survives relaunch and getMe() restores the session on cold start.
enum ZentosSession {
    static let shared: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = .shared
        cfg.httpCookieAcceptPolicy = .always
        cfg.httpShouldSetCookies = true
        return URLSession(configuration: cfg)
    }()
}
```

---

## Model types

```swift
import Foundation

struct AuthUser: Codable, Equatable {
    let address: String
    let email: String?
    let name: String?
    let picture: String?
    var isNew: Bool?        // present on /api/auth/google
    var isExported: Bool?   // present on /api/auth/me
}

struct SignResult: Decodable {
    let digest: String
    let sponsorAddress: String
    let senderAddress: String
}

struct SignMessageResult: Decodable {
    let signature: String
    let address: String
}

enum ZentosError: Error { case http(Int, String), notAuthenticated, badResponse }
```

---

## `ZentosClient`

```swift
import Foundation
import SuiKit   // for TransactionBlock in signAndExecuteCustodial

@MainActor
final class ZentosClient {
    static let shared = ZentosClient()
    private let session = ZentosSession.shared
    private var base: String { Env.backendBaseUrl }

    // MARK: - Auth (Lib surface: signInWithGoogle / getMe / signOut)

    /// POST /api/auth/google — exchanges a Google ID token for a Sui address + session cookie.
    @discardableResult
    func signInWithGoogle(idToken: String) async throws -> AuthUser {
        try await postJSON("/api/auth/google", body: ["idToken": idToken], as: AuthUser.self)
    }

    /// GET /api/auth/me — restores the session from the persisted cookie; nil if 401.
    func getMe() async throws -> AuthUser? {
        var req = URLRequest(url: url("/api/auth/me"))
        req.httpMethod = "GET"
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw ZentosError.badResponse }
        if http.statusCode == 401 { return nil }
        guard (200..<300).contains(http.statusCode) else {
            throw ZentosError.http(http.statusCode, String(decoding: data, as: UTF8.self))
        }
        return try JSONDecoder().decode(AuthUser.self, from: data)
    }

    /// POST /api/auth/logout — clears the server cookie.
    func signOut() async throws {
        _ = try await postRaw("/api/auth/logout", body: Data())
        // also clear local cookies so a fresh login starts clean
        if let cookies = HTTPCookieStorage.shared.cookies {
            for c in cookies where c.domain.contains(host(of: base)) {
                HTTPCookieStorage.shared.deleteCookie(c)
            }
        }
    }

    // MARK: - Sign (Lib surface: signAndExecuteCustodial / custodialSignMessage)

    /// Mirror of web lib/signer.ts. Sets sender, builds ONLY the transaction kind,
    /// base64-encodes, and POSTs to /api/wallet/sign. Gasless + popup-less.
    @discardableResult
    func signAndExecuteCustodial(_ tx: inout TransactionBlock, address: String) async throws -> SignResult {
        try tx.setSender(address)                                   // VERIFY: SuiKit API
        let kindBytes = try await tx.build(onlyTransactionKind: true) // VERIFY: SuiKit API — see fallback below
        let b64 = Data(kindBytes).base64EncodedString()
        return try await postJSON("/api/wallet/sign",
                                  body: ["txKindBytes": b64], as: SignResult.self)
    }

    /// Overload that accepts already-built tx-kind bytes — use this if you hand-build the
    /// TransactionKind BCS (see references/suikit.md fallback) instead of trusting SuiKit's
    /// onlyTransactionKind flag. The HTTP contract here is exact and SDK-independent.
    @discardableResult
    func signAndExecuteCustodial(txKindBytes: Data, address: String) async throws -> SignResult {
        try await postJSON("/api/wallet/sign",
                           body: ["txKindBytes": txKindBytes.base64EncodedString()],
                           as: SignResult.self)
    }

    /// POST /api/wallet/sign-message — signs a personal message with the custodial key.
    /// (Lib surface name is `custodialSignMessage`; it needs the message bytes.)
    func custodialSignMessage(_ message: Data) async throws -> SignMessageResult {
        try await postJSON("/api/wallet/sign-message",
                           body: ["message": message.base64EncodedString()],
                           as: SignMessageResult.self)
    }

    // MARK: - Plumbing

    private func url(_ path: String) -> URL { URL(string: base + path)! }
    private func host(of s: String) -> String { URL(string: s)?.host ?? s }

    private func postJSON<T: Decodable>(_ path: String,
                                        body: [String: String],
                                        as type: T.Type) async throws -> T {
        let data = try await postRaw(path, body: try JSONSerialization.data(withJSONObject: body))
        return try JSONDecoder().decode(T.self, from: data)
    }

    @discardableResult
    private func postRaw(_ path: String, body: Data) async throws -> Data {
        var req = URLRequest(url: url(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw ZentosError.badResponse }
        if http.statusCode == 401 { throw ZentosError.notAuthenticated }
        guard (200..<300).contains(http.statusCode) else {
            throw ZentosError.http(http.statusCode, String(decoding: data, as: UTF8.self))
        }
        return data
    }
}
```

---

## `AppState` — wiring it into SwiftUI

```swift
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var user: AuthUser?
    @Published var isLoading = false

    var isSignedIn: Bool { user != nil }

    /// Called on launch — the persisted cookie means this often restores silently.
    func restoreSession() async {
        user = try? await ZentosClient.shared.getMe()
    }

    func signIn() async {
        isLoading = true; defer { isLoading = false }
        do {
            let idToken = try await fetchGoogleIdToken()                 // SKILL.md
            user = try await ZentosClient.shared.signInWithGoogle(idToken: idToken)
        } catch {
            print("sign-in failed:", error)
        }
    }

    func signOut() async {
        try? await ZentosClient.shared.signOut()
        user = nil
    }
}
```

---

## Notes & VERIFY summary

- The **only** uncertain SDK calls here are `tx.setSender(_:)` and
  `tx.build(onlyTransactionKind:)` from SuiKit — both tagged `// VERIFY: SuiKit API`.
  If your pinned SuiKit lacks an `onlyTransactionKind` flag, build the TransactionKind BCS
  yourself (see `references/suikit.md`) and use the `signAndExecuteCustodial(txKindBytes:address:)`
  overload — the rest of the contract is exact.
- Everything HTTP — paths, JSON bodies (`idToken`, `txKindBytes`, `message`), response
  shapes, cookie handling — comes straight from source-of-truth §6 and is not a guess.
- `/api/wallet/export` is intentionally omitted from the default client surface; add it
  only if you ship the self-custody escape hatch.
