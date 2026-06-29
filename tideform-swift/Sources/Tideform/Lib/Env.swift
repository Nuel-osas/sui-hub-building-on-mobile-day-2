//
//  Env.swift
//  Tideform · Lib layer
//
//  Single source of runtime configuration, mirroring the Expo `lib/env.ts` surface:
//    network, packageId, originalPackageId, walrusAggregator, backendBaseUrl,
//    googleClientId, sealKeyServers, sealThreshold.
//
//  Values are read from the app's Info.plist keys (populated from Config.xcconfig
//  build settings — see Config.xcconfig.example) and fall back to the live MAINNET
//  defaults from the architecture source-of-truth so the app works out of the box.
//
//  Usage: `env.packageId`, `env.rpcURL`, ... (global `env` instance, like JS).
//

import Foundation

public struct Env: Sendable {

    // MARK: - Network

    /// "mainnet" | "testnet" | "devnet" | "localnet"
    public let network: String

    /// Fullnode JSON-RPC endpoint derived from `network`.
    public let rpcURL: URL

    // MARK: - Tideform Move package (source-of-truth §2)

    /// `published-at` — used for moveCall targets.
    public let packageId: String

    /// `original-id` — used for event type-origin queries (never changes across upgrades).
    public let originalPackageId: String

    // MARK: - Walrus

    /// Public aggregator base URL for reads (no auth).
    public let walrusAggregator: String

    // MARK: - Zentos backend (custodial auth + sponsored signing + sponsored uploads)

    /// Defaults to the live deployment so the app works out of the box; overridable.
    public let backendBaseUrl: String

    // MARK: - Auth

    /// Google OAuth client id used by the native Google sign-in (UI layer).
    public let googleClientId: String

    // MARK: - Seal (private fields — Swift decryption is backend-delegated; see README)

    public let sealKeyServers: [String]
    public let sealThreshold: Int

    // MARK: - Defaults (live MAINNET values, source-of-truth §2/§5/§7)

    public enum Defaults {
        public static let network = "mainnet"
        public static let packageId =
            "0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4"
        public static let originalPackageId =
            "0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4"
        public static let walrusAggregatorMainnet =
            "https://aggregator.walrus-mainnet.walrus.space"
        public static let walrusAggregatorTestnet =
            "https://aggregator.walrus-testnet.walrus.space"
        public static let backendBaseUrl = "https://tidalform.xyz"
        /// Mainnet Seal key server (free, public, threshold 1).
        public static let sealKeyServers =
            ["0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a"]
        public static let sealThreshold = 1
    }

    // MARK: - Init from Info.plist (+ defaults)

    public init(bundle: Bundle = .main) {
        let network = Env.plist(bundle, "SUI_NETWORK") ?? Defaults.network
        self.network = network
        self.rpcURL = Env.fullnodeURL(for: network)

        self.packageId = Env.plist(bundle, "TIDEFORM_PACKAGE_ID") ?? Defaults.packageId
        self.originalPackageId =
            Env.plist(bundle, "TIDEFORM_ORIGINAL_PACKAGE_ID") ?? Defaults.originalPackageId

        self.walrusAggregator =
            Env.plist(bundle, "WALRUS_AGGREGATOR")
            ?? (network == "testnet"
                ? Defaults.walrusAggregatorTestnet
                : Defaults.walrusAggregatorMainnet)

        self.backendBaseUrl = Env.plist(bundle, "BACKEND_BASE_URL") ?? Defaults.backendBaseUrl

        // No safe default for an OAuth client id — surface empties so the UI can warn.
        // VERIFY: set GOOGLE_CLIENT_ID in Config.xcconfig (iOS OAuth client from Google Cloud).
        self.googleClientId = Env.plist(bundle, "GOOGLE_CLIENT_ID") ?? ""

        if let raw = Env.plist(bundle, "SEAL_KEY_SERVERS") {
            let parsed = raw.split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            self.sealKeyServers = parsed.isEmpty ? Defaults.sealKeyServers : parsed
        } else {
            self.sealKeyServers = Defaults.sealKeyServers
        }

        self.sealThreshold =
            Env.plist(bundle, "SEAL_THRESHOLD").flatMap { Int($0) } ?? Defaults.sealThreshold
    }

    // MARK: - Helpers

    private static func plist(_ bundle: Bundle, _ key: String) -> String? {
        guard let raw = bundle.object(forInfoDictionaryKey: key) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // Ignore empties and unexpanded build-setting placeholders like "$(SUI_NETWORK)".
        if trimmed.isEmpty || trimmed.hasPrefix("$(") { return nil }
        return trimmed
    }

    public static func fullnodeURL(for network: String) -> URL {
        switch network {
        case "testnet": return URL(string: "https://fullnode.testnet.sui.io:443")!
        case "devnet": return URL(string: "https://fullnode.devnet.sui.io:443")!
        case "localnet": return URL(string: "http://127.0.0.1:9000")!
        default: return URL(string: "https://fullnode.mainnet.sui.io:443")!
        }
    }
}

/// Global config instance — mirrors the JS `env` import (`import { env } from "../lib/env"`).
public let env = Env()
