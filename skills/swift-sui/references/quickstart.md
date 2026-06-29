# Quickstart — a minimal zkLogin login screen in SwiftUI (Day-1 mirror)

This is the **Day-1** model: on-device, non-custodial **zkLogin**. The user signs in with
Google, an ephemeral keypair is generated on the phone, a ZK proof binds it to a Sui
address, and that address signs for the session. No backend holds the key.

> **Read this first — honesty:** zkLogin in pure Swift is where SuiKit is **least mature**.
> The Google sign-in and the SwiftUI screen are solid. The zkLogin crypto — nonce
> construction, calling the prover, deriving the address from `sub`+`aud`+salt, and
> assembling the zkLogin signature — is partially or entirely missing from SuiKit depending
> on version. **Every such step below is `// VERIFY: SuiKit API` and must be confirmed
> against your pinned SuiKit before you trust it.** For a shippable app, prefer the **Day-2
> custodial** path in `SKILL.md` (it deletes all of this). This file exists so the class can
> see the contrast and so the Day-1 zkLogin screen has a SwiftUI form.

---

## What the screen does

1. Generate an ephemeral Ed25519 keypair (lives only in memory / Keychain for the session).
2. Fetch the current epoch from the fullnode and set `maxEpoch = epoch + N`.
3. Build the zkLogin **nonce** from the ephemeral public key + `maxEpoch` + randomness.
4. Run Google sign-in **with that nonce** → Google ID token (JWT).
5. POST `{ jwt, extendedEphemeralPublicKey, maxEpoch, jwtRandomness, salt }` to the
   **prover** → ZK proof.
6. Derive the **zkLogin address** from the JWT (`sub`, `aud`, `iss`) + user salt.
7. From then on, sign transactions with `ephemeralKey` + the proof (a zkLogin signature).

Steps 1, 2, 4 are dependable. Steps 3, 5, 6, 7 are the `// VERIFY` zone.

---

## `LoginView.swift`

```swift
import SwiftUI
import GoogleSignIn

struct LoginView: View {
    @StateObject private var vm = ZkLoginViewModel()

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "drop.fill").font(.system(size: 56)).foregroundStyle(.tint)
            Text("Tideform").font(.largeTitle.bold())
            Text("Sign in with Google — no wallet, no seed phrase, no extension.")
                .font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).padding(.horizontal, 40)

            if let addr = vm.address {
                VStack(spacing: 8) {
                    Text("Signed in").font(.headline)
                    Text(addr).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                        .padding(.horizontal, 40)
                }
            }

            Spacer()

            Button {
                Task { await vm.signInWithZkLogin() }
            } label: {
                HStack {
                    if vm.isWorking { ProgressView().tint(.white) }
                    Text(vm.isWorking ? "Proving…" : "Continue with Google")
                }
                .frame(maxWidth: .infinity).padding()
            }
            .buttonStyle(.borderedProminent)
            .disabled(vm.isWorking)
            .padding(.horizontal, 24)

            if let err = vm.error {
                Text(err).font(.caption).foregroundStyle(.red).padding(.horizontal, 24)
            }
        }
        .padding(.bottom, 40)
    }
}
```

---

## `ZkLoginViewModel.swift`

```swift
import Foundation
import SwiftUI
import GoogleSignIn
import SuiKit   // keys/BCS reliable; zkLogin helpers // VERIFY: SuiKit API

@MainActor
final class ZkLoginViewModel: ObservableObject {
    @Published var address: String?
    @Published var isWorking = false
    @Published var error: String?

    // Day-1 prover. Override per network. (Mysten-hosted dev prover shown; confirm yours.)
    private let proverURL = URL(string: "https://prover-dev.mystenlabs.com/v1")! // VERIFY: prover endpoint for your network

    func signInWithZkLogin() async {
        isWorking = true; error = nil; defer { isWorking = false }
        do {
            // 1. ephemeral keypair (in-memory for the session)
            let ephemeral = try Account()                                  // VERIFY: SuiKit API — Ed25519 keypair

            // 2. current epoch -> maxEpoch
            let epoch = try await currentEpoch()
            let maxEpoch = epoch + 2

            // 3. nonce from ephemeral pubkey + maxEpoch + randomness
            let randomness = ZkLogin.generateRandomness()                  // VERIFY: SuiKit API
            let nonce = try ZkLogin.generateNonce(                         // VERIFY: SuiKit API
                ephemeralPublicKey: ephemeral.publicKey,
                maxEpoch: maxEpoch,
                randomness: randomness
            )

            // 4. Google sign-in WITH the nonce -> JWT
            let jwt = try await googleIdToken(nonce: nonce)

            // 5. user salt (Day-1: from a salt service or deterministic per app) -> address inputs
            let salt = try await fetchUserSalt(jwt: jwt)                   // VERIFY: salt source (app-specific)

            // 6. prover -> ZK proof
            let proof = try await requestProof(
                jwt: jwt,
                extendedEphemeralPublicKey: ZkLogin.extendedEphemeralPublicKey(ephemeral.publicKey), // VERIFY: SuiKit API
                maxEpoch: maxEpoch,
                jwtRandomness: randomness,
                salt: salt
            )
            _ = proof // held for signing; assembling the zkLogin signature is // VERIFY: SuiKit API

            // 7. derive zkLogin address from jwt (sub/aud/iss) + salt
            address = try ZkLogin.deriveAddress(jwt: jwt, salt: salt)      // VERIFY: SuiKit API
        } catch {
            self.error = String(describing: error)
        }
    }

    // --- reliable bits ---

    /// suix_getLatestSuiSystemState.epoch  (stable JSON-RPC; reuses SuiRPC from suikit.md)
    private func currentEpoch() async throws -> UInt64 {
        struct State: Decodable { let epoch: String }
        let s: State = try await SuiRPC.shared.call("suix_getLatestSuiSystemState", [])
        return UInt64(s.epoch) ?? 0
    }

    @MainActor
    private func googleIdToken(nonce: String) async throws -> String {
        guard let root = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController }).first
        else { throw NSError(domain: "zk", code: 1) }
        // Passing the zkLogin nonce so the JWT is bound to the ephemeral key.
        let result = try await GIDSignIn.sharedInstance.signIn(
            withPresenting: root, hint: nil, additionalScopes: nil, nonce: nonce) // VERIFY: GoogleSignIn nonce param signature
        guard let jwt = result.user.idToken?.tokenString else { throw NSError(domain: "zk", code: 2) }
        return jwt
    }

    // --- VERIFY zone: prover + salt (no SuiKit guarantee) ---

    private func fetchUserSalt(jwt: String) async throws -> String {
        // Day-1 options: a hosted salt service, or a deterministic per-app salt.
        // Do NOT hard-code a random salt — it must be stable per (iss, sub, aud).
        // VERIFY: salt strategy for your app (source-of-truth §11 covers decentralized salt)
        return "0" // placeholder — replace with your salt source
    }

    private func requestProof(jwt: String, extendedEphemeralPublicKey: String,
                              maxEpoch: UInt64, jwtRandomness: String, salt: String) async throws -> Data {
        var req = URLRequest(url: proverURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "jwt": jwt,
            "extendedEphemeralPublicKey": extendedEphemeralPublicKey,
            "maxEpoch": String(maxEpoch),
            "jwtRandomness": jwtRandomness,
            "salt": salt,
            "keyClaimName": "sub",
        ])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) == true else {
            throw NSError(domain: "prover", code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                          userInfo: [NSLocalizedDescriptionKey: String(decoding: data, as: UTF8.self)])
        }
        return data // the ZK proof JSON; shape is prover-defined // VERIFY: proof response shape
    }
}

/// Placeholder facade over SuiKit's zkLogin surface. Every method here must be replaced
/// with the confirmed SuiKit call (or your own crypto) — they are NOT verified to exist.
enum ZkLogin {
    static func generateRandomness() -> String { fatalError("VERIFY: SuiKit API — zkLogin randomness") }
    static func generateNonce(ephemeralPublicKey: Any, maxEpoch: UInt64, randomness: String) throws -> String {
        fatalError("VERIFY: SuiKit API — zkLogin nonce")
    }
    static func extendedEphemeralPublicKey(_ pub: Any) -> String { fatalError("VERIFY: SuiKit API") }
    static func deriveAddress(jwt: String, salt: String) throws -> String {
        fatalError("VERIFY: SuiKit API — zkLogin address derivation")
    }
}
```

---

## Why Day-2 custodial is the recommended mobile path

Everything in the `// VERIFY` zone above — nonce, prover round-trip, salt management,
address derivation, zkLogin signature assembly — **disappears** in the custodial model.
There, the same Google ID token goes to `POST /api/auth/google`, the backend mints/holds
the key and returns the address, and signing is a single `POST /api/wallet/sign` that is
also **gasless**. Compare:

```swift
// Day-2 custodial — the entire login, no zkLogin crypto, no prover, no salt:
let idToken = try await fetchGoogleIdToken()                       // SKILL.md
let user = try await ZentosClient.shared.signInWithGoogle(idToken: idToken)
app.user = user   // { address, email, name, picture, isNew } — done.
```

Use this quickstart to **teach** the zkLogin shape and to wire the login screen; ship with
the custodial client in `references/zentos-backend.md` unless you specifically need
on-device non-custodial keys. The decentralized-zkLogin module (salt on Walrus gated by an
on-chain `seal_approve`, self-hosted GPU prover) is the bridge between the two — see
source-of-truth §11 and `zentos/docs/decentralized-zklogin.md`.
