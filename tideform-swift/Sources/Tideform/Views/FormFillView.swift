//
//  FormFillView.swift
//  Tideform · Views (UI)
//
//  Flows C + D (source-of-truth §9): view a form, fill it, submit it. The Swift mirror of
//  the Expo `app/f/[id].tsx`.
//
//  C (view):   indexer.fetchForm(id) → indexer.fetchFormSchema(schemaBlobId) → render every
//              field by type via `FieldView` (all on-device, public reads).
//  D (submit): assemble the `Submission` JSON (public fields only — see the Seal boundary)
//              → walrus.uploadJson() to the SPONSORED Walrus route → get blob_id →
//              Move.txSubmit(formId:blobId:) → zentos.signAndExecuteCustodial(tx:address:)
//              → show the tx digest + Walrus receipt. ZERO gas, ZERO popups (§9.D).
//
//  The only two steps that leave the device are the two that need a server-held secret: the
//  sponsored Walrus upload and the custodial sign+sponsor. Everything else is local.
//
//  Seal boundary (source-of-truth §7): Swift has no Seal SDK, so `private` fields are shown
//  read-only (`FieldView(locked:)`) and OMITTED from the submission. Public fields work
//  fully. We never write placeholder bytes and call them encryption.
//

import Foundation
import SwiftUI
import SuiKit   // only to name the `TransactionBlock` produced by Move.txSubmit on submit

// MARK: - View model

@MainActor
final class FormFillModel: ObservableObject {

    enum Phase: Equatable {
        case loading
        case ready
        case submitting
        case done
        case error
    }

    struct Receipt: Equatable {
        let digest: String
        let blobId: String
        let walCost: String?
        let endEpoch: Int?
    }

    let formId: String

    @Published var phase: Phase = .loading
    @Published var form: FormObject?
    @Published var schema: FormSchema?
    @Published var values: [String: FieldDraft] = [:]
    @Published var fieldErrors: [String: String] = [:]
    @Published var loadError: String?
    @Published var submitError: String?
    @Published var progress: String = ""
    @Published var receipt: Receipt?

    private let indexer: Indexer
    private let walrus: Walrus
    private let zentos: ZentosClient

    init(
        formId: String,
        indexer: Indexer = .shared,
        walrus: Walrus = .shared,
        zentos: ZentosClient = .shared
    ) {
        self.formId = formId
        self.indexer = indexer
        self.walrus = walrus
        self.zentos = zentos
    }

    /// Flattened fields across sections, in order.
    var fields: [Field] { schema?.allFields ?? [] }
    var hasPrivate: Bool { fields.contains { $0.isPrivate } }
    var isClosed: Bool { (form?.status ?? 0) != 0 }

    // MARK: Load (Flow C)

    func load() async {
        phase = .loading
        loadError = nil
        do {
            let f = try await indexer.fetchForm(formId)
            let s = try await indexer.fetchFormSchema(f.schemaBlobId)
            var initial: [String: FieldDraft] = [:]
            for field in s.allFields where !field.isPrivate {
                initial[field.id] = FieldDraft.defaultDraft(for: field)
            }
            form = f
            schema = s
            values = initial
            phase = .ready
        } catch {
            loadError = describe(error)
            phase = .error
        }
    }

    func binding(for field: Field) -> Binding<FieldDraft> {
        Binding(
            get: { self.values[field.id] ?? FieldDraft.defaultDraft(for: field) },
            set: { newValue in
                self.values[field.id] = newValue
                self.fieldErrors[field.id] = nil
            })
    }

    // MARK: Submit (Flow D)

    func submit(address: String) async {
        guard let schema, let form else { return }
        if form.status != 0 {
            submitError = "This form is not open for submissions."
            return
        }
        guard validate() else { return }

        phase = .submitting
        submitError = nil
        do {
            // 1. Assemble the Submission.fields map (public fields only on iOS v1).
            progress = "Packaging…"
            var fieldValues: [String: FieldValue] = [:]
            for field in fields where !field.isPrivate {
                guard let draft = values[field.id], !draft.isEmpty else { continue }
                fieldValues[field.id] = .plaintext(value: draft.asJSON())
            }

            let submission = Submission(
                formId: formId,
                formVersion: schema.formVersion,
                submittedAt: ISO8601DateFormatter().string(from: Date()),
                submitter: address,
                fields: fieldValues)

            // 2. Upload payload to Walrus via the SPONSORED backend route.
            progress = "Uploading to Walrus (sponsored)…"
            let upload = try await walrus.uploadJson(submission, owner: address)
            guard !upload.blobId.isEmpty else {
                throw FillError.message("Walrus upload returned no blob_id.")
            }

            // 3. Build submission::submit PTB → backend signs + sponsors it (gasless).
            progress = "Submitting on-chain (gasless)…"
            let tx: TransactionBlock = try Move.txSubmit(formId: formId, blobId: upload.blobId)
            let res = try await zentos.signAndExecuteCustodial(tx: tx, address: address)

            receipt = Receipt(
                digest: res.digest,
                blobId: upload.blobId,
                walCost: upload.walCost.flatMap { $0.doubleValue.map(numberString) ?? $0.stringValue },
                endEpoch: upload.endEpoch)
            phase = .done
        } catch {
            submitError = describe(error)
            phase = .ready   // stay on the form so the user can retry
        }
        progress = ""
    }

    /// Reset to a fresh blank form (after a successful submit).
    func resetForAnother() {
        var blank: [String: FieldDraft] = [:]
        for field in fields where !field.isPrivate {
            blank[field.id] = FieldDraft.defaultDraft(for: field)
        }
        values = blank
        fieldErrors = [:]
        receipt = nil
        phase = .ready
    }

    private func validate() -> Bool {
        var next: [String: String] = [:]
        for field in fields where field.required && !field.isPrivate {
            let draft = values[field.id] ?? FieldDraft.defaultDraft(for: field)
            if draft.isEmpty { next[field.id] = "Required" }
        }
        fieldErrors = next
        return next.isEmpty
    }

    private func describe(_ error: Error) -> String {
        if let f = error as? FillError, case let .message(m) = f { return m }
        if let w = error as? WalrusError { return w.description }
        if let z = error as? ZentosError { return z.description }
        if let s = error as? SuiRPCError { return s.description }
        if let i = error as? IndexerError { return i.description }
        if let m = error as? MoveError, case let .build(b) = m { return "Tx build failed: \(b)" }
        return (error as NSError).localizedDescription
    }

    enum FillError: Error { case message(String) }
}

// MARK: - View

struct FormFillView: View {
    let formId: String
    @EnvironmentObject private var auth: AuthModel
    @StateObject private var model: FormFillModel
    @Environment(\.dismiss) private var dismiss

    init(formId: String) {
        self.formId = formId
        _model = StateObject(wrappedValue: FormFillModel(formId: formId))
    }

    var body: some View {
        content
            .background { Palette.bg.ignoresSafeArea() }
            .navigationTitle("Form")
            .navigationBarTitleDisplayMode(.inline)
            .task { if model.phase == .loading { await model.load() } }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView().tint(Palette.primary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .error:
            VStack(spacing: 12) {
                Text("Couldn't load this form")
                    .font(.headline).foregroundStyle(Palette.text)
                Text(model.loadError ?? "Unknown error")
                    .font(.subheadline).foregroundStyle(Palette.muted)
                    .multilineTextAlignment(.center)
                Button("Retry") { Task { await model.load() } }
                    .buttonStyle(.borderedProminent).tint(Palette.primary)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .done:
            doneView

        case .ready, .submitting:
            formView
        }
    }

    // MARK: Done

    private var doneView: some View {
        ScrollView {
            VStack(spacing: 14) {
                if let r = model.receipt {
                    ReceiptView(
                        txDigest: r.digest,
                        blobId: r.blobId,
                        walCost: r.walCost,
                        endEpoch: r.endEpoch)
                }
                Button {
                    model.resetForAnother()
                } label: {
                    Text("Submit another")
                        .font(.headline).foregroundStyle(Palette.onPrimary)
                        .frame(maxWidth: .infinity).padding(.vertical, 16)
                        .background(Palette.primary, in: RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)

                Button("Back to my forms") { dismiss() }
                    .foregroundStyle(Palette.muted)
                    .padding(.vertical, 8)
            }
            .padding(18)
        }
    }

    // MARK: Fill

    private var submitting: Bool { model.phase == .submitting }

    private var formView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(model.schema?.title ?? "")
                    .font(.largeTitle.weight(.heavy))
                    .foregroundStyle(Palette.text)
                    .padding(.bottom, 6)

                if let desc = model.schema?.description, !desc.isEmpty {
                    Text(desc)
                        .font(.subheadline)
                        .foregroundStyle(Palette.muted)
                        .padding(.bottom, 14)
                }

                if model.isClosed {
                    banner(
                        text: "This form is \(model.form?.status == 1 ? "closed" : "archived") — new submissions are disabled.",
                        color: Palette.warn)
                }

                if model.hasPrivate {
                    banner(
                        text: "This form has private (Seal) fields. iOS v1 has no Seal SDK, so they are shown locked and omitted from your submission. Public fields submit fully.",
                        color: Palette.accent)
                }

                ForEach(model.schema?.sections ?? []) { section in
                    if let title = section.title, !title.isEmpty {
                        Text(title.uppercased())
                            .font(.caption.weight(.heavy))
                            .kerning(0.6)
                            .foregroundStyle(Palette.text.opacity(0.8))
                            .padding(.top, 8).padding(.bottom, 12)
                    }
                    ForEach(section.fields) { field in
                        FieldView(
                            field: field,
                            draft: model.binding(for: field),
                            locked: field.isPrivate,
                            error: model.fieldErrors[field.id])
                    }
                }

                if let err = model.submitError, !err.isEmpty {
                    Text(err)
                        .font(.subheadline)
                        .foregroundStyle(Palette.danger)
                        .padding(.bottom, 12)
                }

                submitButton

                Text("On submit there is no gas prompt and no wallet popup — the Zentos backend sponsors and co-signs the transaction.")
                    .font(.caption)
                    .foregroundStyle(Palette.muted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 12)
            }
            .padding(18)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var submitButton: some View {
        Button {
            guard let address = auth.user?.address else { return }
            Task { await model.submit(address: address) }
        } label: {
            Group {
                if submitting {
                    HStack(spacing: 10) {
                        ProgressView().tint(Palette.onPrimary)
                        Text(model.progress.isEmpty ? "Submitting…" : model.progress)
                            .font(.headline).foregroundStyle(Palette.onPrimary)
                    }
                } else {
                    Label("Submit · gasless", systemImage: "bolt.fill")
                        .font(.headline).foregroundStyle(Palette.onPrimary)
                }
            }
            .frame(maxWidth: .infinity).padding(.vertical, 16)
            .background(Palette.primary, in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .disabled(submitting || model.isClosed)
        .opacity((submitting || model.isClosed) ? 0.5 : 1)
    }

    private func banner(text: String, color: Color) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(color.opacity(0.4)))
            .padding(.bottom, 14)
    }
}
