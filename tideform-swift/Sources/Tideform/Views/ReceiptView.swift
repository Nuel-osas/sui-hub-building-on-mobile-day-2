//
//  ReceiptView.swift
//  Tideform · Views (UI)
//
//  The success receipt for a gasless, popup-less submit — the Swift mirror of the Expo
//  `components/receipt.tsx`. Surfaces the two artifacts every Tideform write produces
//  (source-of-truth §9.D):
//
//    1. the Sui transaction DIGEST → deep-linked to SuiVision
//    2. the Walrus BLOB ID         → deep-linked to Walruscan + the raw aggregator
//
//  The headline UX lives here: the badge spells out that the user paid 0 SUI gas and saw
//  0 wallet popups, because the Zentos backend sponsored + dual-signed the tx.
//
//  Explorer URLs below are PUBLIC explorers (suivision.xyz / walruscan.com), derived from
//  `env.network` — never hard-coded on-chain identifiers. The raw payload link uses the
//  Lib `walrus.blobUrl(_:)` aggregator URL.
//

import Foundation
import SwiftUI

public struct ReceiptView: View {
    /// Sui transaction digest from `signAndExecuteCustodial`.
    public let txDigest: String?
    /// Walrus blob ID the payload was stored under (this is what went on-chain).
    public let blobId: String?
    /// Optional sponsor cost / storage window returned by the upload route.
    public let walCost: String?
    public let endEpoch: Int?
    public let title: String

    public init(
        txDigest: String? = nil,
        blobId: String? = nil,
        walCost: String? = nil,
        endEpoch: Int? = nil,
        title: String = "Submitted on-chain"
    ) {
        self.txDigest = txDigest
        self.blobId = blobId
        self.walCost = walCost
        self.endEpoch = endEpoch
        self.title = title
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(Palette.ok)
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Palette.text)
            }

            // The whole pitch, in one badge.
            Label("0 SUI gas · 0 popups · sponsored by Zentos", systemImage: "bolt.fill")
                .font(.caption.weight(.bold))
                .foregroundStyle(Palette.primary)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Palette.primary.opacity(0.12), in: Capsule())
                .overlay(Capsule().stroke(Palette.primary.opacity(0.35)))

            if let txDigest {
                LinkRow(label: "Tx digest", value: txDigest, url: Self.suiVisionTxUrl(txDigest))
            }

            if let blobId {
                LinkRow(label: "Walrus blob", value: blobId, url: Self.walruscanBlobUrl(blobId))
                LinkRow(label: "Raw payload", value: blobId, url: walrus.blobUrl(blobId).absoluteString)
            }

            if walCost != nil || endEpoch != nil {
                Text(metaLine)
                    .font(.caption)
                    .foregroundStyle(Palette.muted)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.border))
    }

    private var metaLine: String {
        var parts: [String] = []
        if let walCost { parts.append("WAL cost \(walCost) (paid by sponsor)") }
        if let endEpoch { parts.append("stored through epoch \(endEpoch)") }
        return parts.joined(separator: "  ·  ")
    }

    // MARK: - Network-aware public explorers (mirrors receipt.tsx)

    /// Public Sui explorer for a tx digest, network-aware.
    static func suiVisionTxUrl(_ digest: String) -> String {
        let sub = env.network == "mainnet" ? "" : "\(env.network)."
        return "https://\(sub)suivision.xyz/txblock/\(digest)"
    }

    /// Public Walrus explorer for a blob ID, network-aware.
    static func walruscanBlobUrl(_ blobId: String) -> String {
        let net = env.network == "mainnet" ? "mainnet" : "testnet"
        return "https://walruscan.com/\(net)/blob/\(blobId)"
    }
}

// MARK: - One labeled, tappable link row

private struct LinkRow: View {
    let label: String
    let value: String
    let url: String

    var body: some View {
        Link(destination: URL(string: url) ?? URL(string: "https://suivision.xyz")!) {
            HStack(spacing: 8) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(Palette.muted)
                    .frame(width: 92, alignment: .leading)
                Text(Self.short(value))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Palette.text)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("open")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Palette.accent)
                Image(systemName: "arrow.up.right").font(.caption2).foregroundStyle(Palette.accent)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.border))
        }
    }

    static func short(_ s: String, head: Int = 10, tail: Int = 8) -> String {
        guard s.count > head + tail + 1 else { return s }
        return "\(s.prefix(head))…\(s.suffix(tail))"
    }
}
