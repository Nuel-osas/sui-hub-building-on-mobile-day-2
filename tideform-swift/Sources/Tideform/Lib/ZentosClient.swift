//
//  ZentosClient.swift
//  Tideform · Lib layer
//
//  Native client over the Zentos CUSTODIAL backend, mirroring the Expo `lib/zentos.ts`
//  (auth) + `lib/signer.ts` (sign) surface. The whole point of Day 2: mobile does NOT
//  rebuild auth/signing/gas — it is a thin client over these HTTP routes
//  (source-of-truth §6).
//
//  Auth surface:   signInWithGoogle(idToken), getMe(), signOut()
//  Signing surface: signAndExecuteCustodial(tx, address) / (kindBytesBase64, address),
//                   custodialSignMessage(messageBase64)
//
//  Privileged calls ride a process-wide cookie-aware URLSession (`tideformURLSession`)
//  so the HMAC session cookie set by `/api/auth/google` is replayed automatically
//  (source-of-truth §12). Sponsored signing = the user pays 0 SUI and sees 0 popups.
//

import Foundation
import SuiKit

// MARK: - Shared cookie-aware session (used by ZentosClient, Walrus, SuiClient)

/// One process-wide session whose `HTTPCookieStorage` persists the Zentos session
/// cookie automatically (and replays it only to the matching backend host).
public let tideformURLSession: URLSession = {
    let config = URLSessionConfiguration.default
    config.httpCookieStorage = HTTPCookieStorage.shared
    config.httpCookieAcceptPolicy = .always
    config.httpShouldSetCookies = true
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: config)
}()

// MARK: - Models

/// Identity returned by `/api/auth/google` and `/api/auth/me`.
public struct AuthUser: Codable, Sendable {
    public let address: String
    public let email: String?
    public let name: String?
    public let picture: String?
    /// `/api/auth/google` only.
    public let isNew: Bool?
    /// `/api/auth/me` only — whether the custodial key has been exported.
    public let isExported: Bool?
}

/// Result of `/api/wallet/sign` (sponsored, custodial co-sign + execute).
public struct SignResult: Codable, Sendable {
    public let digest: String
    public let sponsorAddress: String?
    public let senderAddress: String?
}

/// Result of `/api/wallet/sign-message` (custodial personal-message signature).
public struct SignMessageResult: Codable, Sendable {
    public let signature: String
    public let address: String?
}

public enum ZentosError: Error, CustomStringConvertible {
    case notAuthenticated
    case http(status: Int, body: String)
    case badResponse(String)

    public var description: String {
        switch self {
        case .notAuthenticated: return "Not authenticated (401)"
        case .http(let s, let b): return "Zentos HTTP \(s): \(b)"
        case .badResponse(let m): return "Zentos bad response: \(m)"
        }
    }
}

public final class ZentosClient: @unchecked Sendable {

    public static let shared = ZentosClient()

    private let baseURL: String
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(baseURL: String = env.backendBaseUrl, session: URLSession = tideformURLSession) {
        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.session = session
    }

    // MARK: - Auth (source-of-truth §6.1)

    /// Exchange a Google ID token for a Sui session. Persists the Set-Cookie session
    /// in the shared cookie store. Same Google account -> same Sui address forever.
    @discardableResult
    public func signInWithGoogle(idToken: String) async throws -> AuthUser {
        try await postDecoding("/api/auth/google", body: ["idToken": idToken])
    }

    /// Restore the session on launch. Throws `ZentosError.notAuthenticated` on 401.
    public func getMe() async throws -> AuthUser {
        try await getDecoding("/api/auth/me")
    }

    /// Clear the server session + cookie.
    public func signOut() async throws {
        _ = try await send(path: "/api/auth/logout", method: "POST", body: Optional<Data>.none)
    }

    // MARK: - Signing (source-of-truth §6.2/§6.3)

    /// Co-sign + sponsor + execute already-built transaction-kind bytes (base64).
    /// `address` mirrors the web signer signature; the backend derives the sender from
    /// the session cookie, so only `txKindBytes` is sent on the wire.
    @discardableResult
    public func signAndExecuteCustodial(
        kindBytesBase64: String,
        address: String
    ) async throws -> SignResult {
        try await postDecoding("/api/wallet/sign", body: ["txKindBytes": kindBytesBase64])
    }

    /// Convenience overload matching the shared lib contract `signAndExecuteCustodial(tx, address)`.
    /// Sets the sender, serializes `onlyTransactionKind` bytes via SuiKit (Move.swift), and signs.
    @discardableResult
    public func signAndExecuteCustodial(
        tx: TransactionBlock,
        address: String
    ) async throws -> SignResult {
        let kind = try await Move.buildTransactionKindBase64(tx, sender: address)
        return try await signAndExecuteCustodial(kindBytesBase64: kind, address: address)
    }

    /// Sign a personal message with the custodial key (base64 message bytes in, signature
    /// out). This backs Seal's `SessionKey` proof-of-ownership flow on mobile — replacing
    /// the wallet-popup `signPersonalMessage`.
    @discardableResult
    public func custodialSignMessage(messageBase64: String) async throws -> SignMessageResult {
        try await postDecoding("/api/wallet/sign-message", body: ["message": messageBase64])
    }

    // MARK: - HTTP plumbing

    private func url(_ path: String) -> URL { URL(string: baseURL + path)! }

    private func getDecoding<R: Decodable>(_ path: String) async throws -> R {
        let data = try await send(path: path, method: "GET", body: Optional<Data>.none)
        return try decodeBody(data)
    }

    private func postDecoding<R: Decodable>(
        _ path: String, body: [String: String]
    ) async throws -> R {
        let encoded = try encoder.encode(body)
        let data = try await send(path: path, method: "POST", body: encoded)
        return try decodeBody(data)
    }

    private func decodeBody<R: Decodable>(_ data: Data) throws -> R {
        do {
            return try decoder.decode(R.self, from: data)
        } catch {
            throw ZentosError.badResponse("\(error): \(String(data: data, encoding: .utf8) ?? "")")
        }
    }

    /// Performs the request and maps non-2xx -> typed errors (401 -> notAuthenticated).
    @discardableResult
    private func send(path: String, method: String, body: Data?) async throws -> Data {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { return data }
        if http.statusCode == 401 { throw ZentosError.notAuthenticated }
        guard (200..<300).contains(http.statusCode) else {
            throw ZentosError.http(
                status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }
}

/// Module-level alias mirroring the JS `zentos` singleton (`zentos.signInWithGoogle(...)`).
public let zentos = ZentosClient.shared
