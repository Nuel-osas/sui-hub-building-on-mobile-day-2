//
//  MyFormsView.swift
//  Tideform · Views (UI)
//
//  Flow B (source-of-truth §9.B): "My Forms". The Swift mirror of the Expo `app/index.tsx`.
//
//  `indexer.listFormsForOwner(myAddress)` queries the `FormCreated` event by the ORIGINAL
//  package type, keeps forms whose `owner == me`, `multiGetObjects` to read current Form
//  state, then we fetch each schema blob from Walrus to show its title. All of this is
//  on-device reads against PUBLIC endpoints — no backend, no cookie (§12).
//
//  Tap a form → open it (`Route.fill`, Flows C+D). Each row also links to its admin inbox
//  (`Route.inbox`, Flow E) since these are forms you own.
//

import Foundation
import SwiftUI

// MARK: - Row model (FormObject + resolved title)

struct FormRow: Identifiable {
    let form: FormObject
    let title: String
    var id: String { form.id }
}

// MARK: - View model

@MainActor
final class MyFormsModel: ObservableObject {
    @Published var rows: [FormRow] = []
    @Published var loading = true
    @Published var refreshing = false
    @Published var error: String?

    private let indexer: Indexer
    init(indexer: Indexer = .shared) { self.indexer = indexer }

    func load(address: String, refresh: Bool = false) async {
        if refresh { refreshing = true } else { loading = true }
        error = nil
        do {
            let forms = try await indexer.listFormsForOwner(address)
            // Resolve each title from its Walrus schema blob (best-effort per form).
            var built: [FormRow] = []
            for f in forms {
                var title = "(untitled form)"
                if let schema = try? await indexer.fetchFormSchema(f.schemaBlobId),
                    !schema.title.isEmpty
                {
                    title = schema.title
                }
                built.append(FormRow(form: f, title: title))
            }
            // Newest first.
            built.sort { $0.form.createdAtMs > $1.form.createdAtMs }
            rows = built
        } catch {
            self.error = describe(error)
        }
        loading = false
        refreshing = false
    }

    private func describe(_ error: Error) -> String {
        if let s = error as? SuiRPCError { return s.description }
        if let i = error as? IndexerError { return i.description }
        return (error as NSError).localizedDescription
    }
}

// MARK: - View

struct MyFormsView: View {
    @EnvironmentObject private var auth: AuthModel
    @StateObject private var model = MyFormsModel()

    private static let statusLabels = ["OPEN", "CLOSED", "ARCHIVED"]
    private static let statusColors: [Color] = [Palette.ok, Palette.warn, Palette.muted]

    private var address: String? { auth.user?.address }

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                gaslessNote

                if model.loading {
                    ProgressView().tint(Palette.primary).padding(.top, 64)
                } else if model.rows.isEmpty {
                    emptyState
                } else {
                    ForEach(model.rows) { row in
                        card(row)
                    }
                }
            }
            .padding(16)
        }
        .background { Palette.bg.ignoresSafeArea() }
        .navigationTitle("My Forms")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) { greeting }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Sign out") { Task { await auth.signOut() } }
                    .foregroundStyle(Palette.muted)
            }
        }
        .refreshable {
            if let address { await model.load(address: address, refresh: true) }
        }
        .task {
            // Initial load (only once — `.task` re-runs only if id changes).
            if let address, model.rows.isEmpty { await model.load(address: address) }
        }
    }

    // MARK: Pieces

    private var greetingText: String {
        guard let name = auth.user?.name, let first = name.split(separator: " ").first else {
            return "Your forms"
        }
        return "Hi, \(first)"
    }

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(greetingText)
                .font(.headline)
                .foregroundStyle(Palette.text)
            if let address {
                Text(shortAddr(address))
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(Palette.muted)
            }
        }
    }

    private var gaslessNote: some View {
        Label("Submissions are sponsored — 0 SUI gas, 0 popups.", systemImage: "bolt.fill")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Palette.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Palette.primary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.primary.opacity(0.3)))
    }

    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 10) {
            if let error = model.error {
                Text("Couldn't load forms")
                    .font(.headline).foregroundStyle(Palette.text)
                Text(error)
                    .font(.subheadline).foregroundStyle(Palette.muted)
                    .multilineTextAlignment(.center)
                Button("Retry") {
                    if let address { Task { await model.load(address: address) } }
                }
                .buttonStyle(.borderedProminent)
                .tint(Palette.primary)
                .padding(.top, 4)
            } else {
                Text("No forms yet")
                    .font(.headline).foregroundStyle(Palette.text)
                Text("Create a form on tidalform.xyz with this same Google account — it will appear here.")
                    .font(.subheadline).foregroundStyle(Palette.muted)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.top, 64)
        .padding(.horizontal, 16)
    }

    private func card(_ row: FormRow) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // Title + status, tapping the header opens the fill flow.
            NavigationLink(value: Route.fill(formId: row.form.id)) {
                HStack(alignment: .top, spacing: 10) {
                    Text(row.title)
                        .font(.headline)
                        .foregroundStyle(Palette.text)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    statusPill(row.form.status)
                }
            }
            .buttonStyle(.plain)

            Text("\(row.form.submissionsCount) \(row.form.submissionsCount == 1 ? "submission" : "submissions") · v\(row.form.version)")
                .font(.subheadline)
                .foregroundStyle(Palette.muted)

            HStack(spacing: 10) {
                NavigationLink(value: Route.fill(formId: row.form.id)) {
                    Text("Open / fill")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(Palette.primary)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(Palette.primary.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.primary.opacity(0.4)))
                }
                .buttonStyle(.plain)

                NavigationLink(value: Route.inbox(formId: row.form.id)) {
                    Text("Inbox (\(row.form.submissionsCount)) →")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(Palette.accent)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.border))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.border))
    }

    private func statusPill(_ status: UInt8) -> some View {
        let i = Int(status)
        let label = Self.statusLabels.indices.contains(i) ? Self.statusLabels[i] : "?\(status)"
        let color = Self.statusColors.indices.contains(i) ? Self.statusColors[i] : Palette.muted
        return Text(label)
            .font(.caption2.weight(.heavy))
            .foregroundStyle(color)
            .padding(.horizontal, 9).padding(.vertical, 3)
            .overlay(Capsule().stroke(color))
    }
}

// MARK: - Shared address shortener

func shortAddr(_ a: String) -> String {
    a.count > 14 ? "\(a.prefix(8))…\(a.suffix(6))" : a
}
