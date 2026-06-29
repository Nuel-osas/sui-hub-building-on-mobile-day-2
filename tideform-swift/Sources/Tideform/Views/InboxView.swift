//
//  InboxView.swift
//  Tideform · Views (UI)
//
//  Flow E (source-of-truth §9.E): admin inbox. The Swift mirror of the Expo
//  `app/inbox/[id].tsx`.
//
//  `indexer.listSubmissions(formId)` queries `SubmissionReceived` filtered by `form_id`,
//  `multiGetObjects` for current Submission state, then we fetch each payload blob from
//  Walrus and render it with the form's schema via `FieldDisplayView`. All reads are
//  on-device against public endpoints (§12).
//
//  Private fields — the honest Swift boundary (source-of-truth §7):
//    • plaintext              → shown directly (FieldDisplayView).
//    • media / encrypted-media → blob id + a link to the raw aggregator.
//    • encrypted (placeholder) → decoded + clearly labeled "NOT encrypted".
//    • encrypted (seal)       → labeled BACKEND-DELEGATED: Swift has NO Seal SDK, so there
//      is no on-device decrypt here. The proof-of-ownership signature exists
//      (`zentos.custodialSignMessage`), but with no Seal client to consume it, decryption
//      is a documented backend step or a web-admin action. We never fake it.
//

import Foundation
import SwiftUI

// MARK: - Inbox item

struct InboxItem: Identifiable {
    let object: SubmissionObject
    let payload: Submission?
    let payloadError: String?
    var id: String { object.id }
}

// MARK: - View model

@MainActor
final class InboxModel: ObservableObject {
    let formId: String

    @Published var form: FormObject?
    @Published var schema: FormSchema?
    @Published var items: [InboxItem] = []
    @Published var loading = true
    @Published var refreshing = false
    @Published var error: String?

    private let indexer: Indexer
    init(formId: String, indexer: Indexer = .shared) {
        self.formId = formId
        self.indexer = indexer
    }

    /// `fieldId -> Field` for label/type-aware rendering.
    var fieldMap: [String: Field] {
        var map: [String: Field] = [:]
        for f in schema?.allFields ?? [] { map[f.id] = f }
        return map
    }

    func isAdmin(_ address: String?) -> Bool {
        guard let address, let form else { return false }
        let me = address.lowercased()
        if form.owner.lowercased() == me { return true }
        return form.admins.contains { $0.lowercased() == me }
    }

    /// Any field that is real Seal ciphertext (mode == "seal").
    var hasSealCiphertext: Bool {
        for item in items {
            guard let fields = item.payload?.fields else { continue }
            for value in fields.values {
                if case let .encrypted(envelope) = value, envelope.mode == "seal" { return true }
            }
        }
        return false
    }

    func load(refresh: Bool = false) async {
        if refresh { refreshing = true } else { loading = true }
        error = nil
        do {
            async let formTask = indexer.fetchForm(formId)
            async let subsTask = indexer.listSubmissions(formId)
            let f = try await formTask
            var subs = try await subsTask
            let s = try await indexer.fetchFormSchema(f.schemaBlobId)

            // Newest first by on-chain timestamp.
            subs.sort { $0.submittedAtMs > $1.submittedAtMs }

            var loaded: [InboxItem] = []
            for obj in subs {
                do {
                    let payload = try await indexer.fetchSubmissionPayload(obj.blobId)
                    loaded.append(InboxItem(object: obj, payload: payload, payloadError: nil))
                } catch {
                    loaded.append(InboxItem(object: obj, payload: nil, payloadError: describe(error)))
                }
            }

            form = f
            schema = s
            items = loaded
        } catch {
            self.error = describe(error)
        }
        loading = false
        refreshing = false
    }

    private func describe(_ error: Error) -> String {
        if let w = error as? WalrusError { return w.description }
        if let s = error as? SuiRPCError { return s.description }
        if let i = error as? IndexerError { return i.description }
        return (error as NSError).localizedDescription
    }
}

// MARK: - View

struct InboxView: View {
    let formId: String
    @EnvironmentObject private var auth: AuthModel
    @StateObject private var model: InboxModel

    init(formId: String) {
        self.formId = formId
        _model = StateObject(wrappedValue: InboxModel(formId: formId))
    }

    private var isAdmin: Bool { model.isAdmin(auth.user?.address) }

    var body: some View {
        Group {
            if model.loading {
                ProgressView().tint(Palette.primary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                list
            }
        }
        .background { Palette.bg.ignoresSafeArea() }
        .navigationTitle("Inbox")
        .navigationBarTitleDisplayMode(.inline)
        .task { if model.items.isEmpty && model.form == nil { await model.load() } }
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(model.schema?.title ?? "Inbox")
                    .font(.largeTitle.weight(.heavy))
                    .foregroundStyle(Palette.text)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(Palette.muted)

                if !isAdmin {
                    banner(
                        text: "You are not an admin of this form. Public fields are visible, but private (Seal) fields can only be decrypted by the form's admins.",
                        color: Palette.warn)
                }

                if model.hasSealCiphertext {
                    banner(
                        text: "This inbox contains Seal-encrypted fields. iOS v1 has no Seal SDK — on-device decryption is not available. Decrypt them in the web admin, or via a backend-delegated Seal step (custodial sign-message provides proof-of-ownership).",
                        color: Palette.accent)
                }

                if let error = model.error {
                    banner(text: error, color: Palette.danger)
                }

                if model.items.isEmpty {
                    VStack(spacing: 8) {
                        Text("No submissions yet")
                            .font(.headline).foregroundStyle(Palette.text)
                        Text("When someone submits this form, it lands here.")
                            .font(.subheadline).foregroundStyle(Palette.muted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 48)
                } else {
                    ForEach(model.items) { item in
                        SubmissionCard(item: item, fieldMap: model.fieldMap)
                    }
                }
            }
            .padding(16)
        }
        .refreshable { await model.load(refresh: true) }
    }

    private var subtitle: String {
        let n = model.items.count
        var s = "\(n) \(n == 1 ? "submission" : "submissions")"
        if let form = model.form { s += " · \(form.admins.count + 1) admin(s)" }
        return s
    }

    private func banner(text: String, color: Color) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(color.opacity(0.4)))
    }
}

// MARK: - One submission card

private struct SubmissionCard: View {
    let item: InboxItem
    let fieldMap: [String: Field]

    private static let statusLabels = ["NEW", "IN PROGRESS", "RESOLVED", "SPAM"]
    private static let priorityLabels = ["LOW", "MED", "HIGH", "URGENT"]
    private static let priorityColors: [Color] = [Palette.muted, Palette.accent, Palette.warn, Palette.danger]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if !item.object.tags.isEmpty {
                HStack(spacing: 6) {
                    ForEach(item.object.tags, id: \.self) { t in
                        Text("#\(t)")
                            .font(.caption)
                            .foregroundStyle(Palette.accent)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.border))
                    }
                }
                .padding(.top, 10)
            }

            Rectangle().fill(Palette.border).frame(height: 1).padding(.vertical, 14)

            if let err = item.payloadError {
                Text("Couldn't load payload blob: \(err)")
                    .font(.subheadline).foregroundStyle(Palette.danger)
            } else if let payload = item.payload {
                let keys = payload.fields.keys.sorted()
                ForEach(keys, id: \.self) { fieldId in
                    if let value = payload.fields[fieldId] {
                        SubmittedField(
                            field: fieldMap[fieldId],
                            fieldId: fieldId,
                            value: value)
                    }
                }
            } else {
                Text("Empty payload.").font(.subheadline).foregroundStyle(Palette.danger)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.border))
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.formatDate(item.object.submittedAtMs))
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Palette.text)
                Text(item.object.submitter.isEmpty ? "anonymous" : shortAddr(item.object.submitter))
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(Palette.muted)
            }
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                statusPill
                priorityPill
            }
        }
    }

    private var statusPill: some View {
        let i = Int(item.object.status)
        let label = Self.statusLabels.indices.contains(i) ? Self.statusLabels[i] : "?\(item.object.status)"
        return Text(label)
            .font(.caption2.weight(.heavy))
            .foregroundStyle(Palette.muted)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Palette.surface2, in: Capsule())
            .overlay(Capsule().stroke(Palette.border))
    }

    private var priorityPill: some View {
        let i = Int(item.object.priority)
        let label = Self.priorityLabels.indices.contains(i) ? Self.priorityLabels[i] : "?"
        let color = Self.priorityColors.indices.contains(i) ? Self.priorityColors[i] : Palette.muted
        return Text(label)
            .font(.caption2.weight(.heavy))
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .overlay(Capsule().stroke(color))
    }

    private static func formatDate(_ ms: UInt64) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let fmt = DateFormatter()
        fmt.dateStyle = .medium
        fmt.timeStyle = .short
        return fmt.string(from: date)
    }
}

// MARK: - One field within a submission

private struct SubmittedField: View {
    let field: Field?
    let fieldId: String
    let value: FieldValue

    private var label: String { field?.label.isEmpty == false ? field!.label : fieldId }

    var body: some View {
        switch value {
        case .plaintext(let json):
            if let field {
                FieldDisplayView(field: field, value: json)
            } else {
                fallback(body: jsonDisplayString(json).isEmpty ? "—" : jsonDisplayString(json))
            }

        case .media(let blobId, let mime, let bytes, _):
            mediaRow(icon: "paperclip", blobId: blobId, sub: "\(mime) · \(bytes) bytes")

        case .encryptedMedia(let blobId, _, _, _, _):
            mediaRow(icon: "lock.fill", blobId: blobId, sub: "encrypted media (Seal) — raw ciphertext")

        case .encrypted(let envelope):
            encryptedField(envelope)
        }
    }

    // MARK: encrypted variants

    @ViewBuilder
    private func encryptedField(_ envelope: SealEnvelope) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text)

            if envelope.mode == "placeholder" {
                // The placeholder base64-wraps PLAINTEXT — decode and label loudly.
                tag(text: "PLACEHOLDER — not encrypted (submitter had no Seal)", color: Palette.warn, icon: "exclamationmark.triangle.fill")
                Text(decodePlaceholder(envelope.b64))
                    .foregroundStyle(Palette.text)
            } else {
                // mode == "seal": real ciphertext. No on-device decrypt on Swift.
                tag(text: "Seal-encrypted · decryption is backend-delegated on iOS (no Seal SDK)", color: Palette.accent, icon: "lock.fill")
            }
        }
        .padding(.bottom, 12)
    }

    private func decodePlaceholder(_ b64: String) -> String {
        guard let data = Data(base64Encoded: b64),
            let s = String(data: data, encoding: .utf8)
        else { return "(unreadable)" }
        return s
    }

    // MARK: helpers

    private func mediaRow(icon: String, blobId: String, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text)
            LinkText(label: blobId, url: walrus.blobUrl(blobId).absoluteString)
            Text(sub).font(.caption).foregroundStyle(Palette.muted)
        }
        .padding(.bottom, 12)
        .overlay(alignment: .topTrailing) {
            Image(systemName: icon).font(.caption2).foregroundStyle(Palette.muted)
        }
    }

    private func fallback(body: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text)
            Text(body).foregroundStyle(Palette.text)
        }
        .padding(.bottom, 12)
    }

    private func tag(text: String, color: Color, icon: String) -> some View {
        Label(text, systemImage: icon)
            .font(.caption2.weight(.bold))
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(color.opacity(0.45)))
    }
}
