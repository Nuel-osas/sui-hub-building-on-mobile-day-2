//
//  FieldView.swift
//  Tideform · Views (UI)
//
//  Renders ALL 14 Tideform field types (source-of-truth §8), the Swift mirror of the
//  Expo `components/field-renderer.tsx`. One file, two entry points:
//
//    • `FieldView`        — an interactive control bound to a `FieldDraft` (fill mode).
//    • `FieldDisplayView` — a read-only display of a submitted `JSONValue` (admin inbox).
//
//  The 14 types: short_text, long_text, rich_text, dropdown, multi_select, checkbox,
//  rating, screenshot, video, url, number, date, email, wallet.
//
//  Dependency honesty (matches the Expo note): this layer ships only SwiftUI — no native
//  image/document picker — so `screenshot`/`video` accept a Walrus blob ID or URL, and
//  `date` is a typed YYYY-MM-DD field. Wiring `PhotosPicker` / a graphical `DatePicker`
//  is a clearly-labeled next step, not faked here.
//
//  Private fields: Swift has NO Seal SDK (source-of-truth §7), so a `private` field in
//  FILL mode is rendered `locked` — visible but not collected — and omitted from the
//  submission. We never write placeholder bytes and call them encryption.
//

import Foundation
import SwiftUI

// MARK: - FieldDraft — the in-progress value for one field (shared with FormFillView)

/// A small, type-safe union for an in-progress answer. Maps 1:1 to the `FieldValue
/// .plaintext` `JSONValue` we upload at submit time (see `asJSON()`).
public enum FieldDraft: Equatable {
    case text(String)        // short_text, long_text, rich_text, url, number, date, email, wallet, dropdown, screenshot, video
    case bool(Bool)          // checkbox
    case multi([String])     // multi_select
    case rating(Int)         // rating

    /// Mirrors the Expo `isEmpty`: blank string / empty array / unticked / unrated.
    public var isEmpty: Bool {
        switch self {
        case .text(let s): return s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .bool(let b): return b == false
        case .multi(let a): return a.isEmpty
        case .rating(let n): return n == 0
        }
    }

    /// Encode for the `Submission` JSON payload (`FieldValue.plaintext(value:)`).
    public func asJSON() -> JSONValue {
        switch self {
        case .text(let s): return .string(s)
        case .bool(let b): return .bool(b)
        case .multi(let a): return .array(a.map { .string($0) })
        case .rating(let n): return .number(Double(n))
        }
    }

    /// Initial value for a field — its `defaultValue` if present, else a type-appropriate blank.
    public static func defaultDraft(for field: Field) -> FieldDraft {
        if let dv = field.defaultValue, dv != .null {
            switch field.type {
            case .multiSelect:
                if let arr = dv.arrayValue { return .multi(arr.compactMap { $0.stringValue }) }
            case .checkbox:
                if let b = dv.boolValue { return .bool(b) }
            case .rating:
                if let n = dv.intValue { return .rating(n) }
            default:
                if let s = dv.stringValue { return .text(s) }
                if let n = dv.doubleValue { return .text(numberString(n)) }
            }
        }
        switch field.type {
        case .multiSelect: return .multi([])
        case .checkbox: return .bool(false)
        case .rating: return .rating(0)
        default: return .text("")
        }
    }
}

// MARK: - Shared helpers

/// Rating ceiling — `validation.maxRating` (source-of-truth §8) or 5.
func ratingMax(_ field: Field) -> Int {
    if let m = field.validation?["maxRating"]?.intValue, m > 0 { return m }
    return 5
}

/// The stable string key used to select a `FieldOption` (dropdown/multi-select).
func optionKey(_ option: FieldOption) -> String {
    jsonScalarString(option.value).isEmpty ? option.label : jsonScalarString(option.value)
}

/// A compact decimal string ("5" not "5.0") for integral doubles.
func numberString(_ n: Double) -> String {
    n == n.rounded() ? String(Int(n)) : String(n)
}

/// Scalar -> string (no recursion); arrays/objects render empty here.
func jsonScalarString(_ v: JSONValue) -> String {
    switch v {
    case .string(let s): return s
    case .number(let n): return numberString(n)
    case .bool(let b): return String(b)
    default: return ""
    }
}

/// Human display of any JSON value (used by the read-only inbox renderer).
func jsonDisplayString(_ v: JSONValue) -> String {
    switch v {
    case .string(let s): return s
    case .number(let n): return numberString(n)
    case .bool(let b): return b ? "Yes" : "No"
    case .array(let a): return a.map { jsonDisplayString($0) }.joined(separator: ", ")
    case .object, .null: return ""
    }
}

// MARK: - FieldView (fill mode)

public struct FieldView: View {
    public let field: Field
    @Binding public var draft: FieldDraft
    /// Private field on a stack with no Seal SDK — rendered visible-but-not-collected.
    public var locked: Bool = false
    public var error: String? = nil

    public init(
        field: Field,
        draft: Binding<FieldDraft>,
        locked: Bool = false,
        error: String? = nil
    ) {
        self.field = field
        self._draft = draft
        self.locked = locked
        self.error = error
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FieldLabel(field: field)

            if let help = field.help, !help.isEmpty {
                Text(help)
                    .font(.caption)
                    .foregroundStyle(Palette.muted)
            }

            if locked {
                LockedPrivateNote()
            } else {
                control
            }

            if let error, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(Palette.danger)
            }
        }
        .padding(.bottom, 12)
    }

    // MARK: Per-type input controls

    @ViewBuilder
    private var control: some View {
        switch field.type {
        case .longText, .richText:
            TextField(field.placeholder ?? "", text: textBinding, axis: .vertical)
                .lineLimit(4...8)
                .textFieldStyle(.plain)
                .tideformInput()

        case .number:
            TextField(field.placeholder ?? "0", text: textBinding)
                .keyboardType(.decimalPad)
                .tideformInput()

        case .email:
            TextField(field.placeholder ?? "you@example.com", text: textBinding)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .tideformInput()

        case .url:
            TextField(field.placeholder ?? "https://…", text: textBinding)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .tideformInput()

        case .wallet:
            TextField(field.placeholder ?? "0x…", text: textBinding)
                .font(.system(.body, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .tideformInput()

        case .date:
            VStack(alignment: .leading, spacing: 4) {
                TextField("YYYY-MM-DD", text: textBinding)
                    .keyboardType(.numbersAndPunctuation)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .tideformInput()
                Text("Typed date (no native picker in this build).")
                    .font(.caption2).italic()
                    .foregroundStyle(Palette.muted)
            }

        case .dropdown:
            DropdownControl(options: field.options ?? [], draft: $draft)

        case .multiSelect:
            MultiSelectControl(options: field.options ?? [], draft: $draft)

        case .checkbox:
            HStack(spacing: 10) {
                Toggle("", isOn: boolBinding)
                    .labelsHidden()
                    .tint(Palette.primary)
                Text(boolBinding.wrappedValue ? "Yes" : "No")
                    .foregroundStyle(Palette.text)
            }

        case .rating:
            RatingControl(max: ratingMax(field), draft: $draft)

        case .screenshot, .video:
            VStack(alignment: .leading, spacing: 4) {
                TextField(
                    field.type == .video ? "Walrus blob ID or video URL"
                        : "Walrus blob ID or image URL",
                    text: textBinding)
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .tideformInput()
                Text("Paste an existing Walrus blob ID or a URL. Native file picking would add a PhotosPicker (out of this stage's scope).")
                    .font(.caption2).italic()
                    .foregroundStyle(Palette.muted)
            }

        case .shortText:
            TextField(field.placeholder ?? "", text: textBinding)
                .tideformInput()
        }
    }

    // MARK: Bindings derived from the FieldDraft

    private var textBinding: Binding<String> {
        Binding(
            get: { if case .text(let s) = draft { return s } else { return "" } },
            set: { draft = .text($0) })
    }

    private var boolBinding: Binding<Bool> {
        Binding(
            get: { if case .bool(let b) = draft { return b } else { return false } },
            set: { draft = .bool($0) })
    }
}

// MARK: - Dropdown / multi-select / rating sub-controls

private struct DropdownControl: View {
    let options: [FieldOption]
    @Binding var draft: FieldDraft

    private var selected: String {
        if case .text(let s) = draft { return s }
        return ""
    }

    var body: some View {
        if options.isEmpty {
            Text("No options configured.")
                .font(.caption).italic().foregroundStyle(Palette.muted)
        } else {
            VStack(spacing: 8) {
                ForEach(options, id: \.self) { opt in
                    let key = optionKey(opt)
                    let active = key == selected
                    Button {
                        draft = .text(key)
                    } label: {
                        HStack {
                            Text(opt.label)
                                .foregroundStyle(active ? Palette.primary : Palette.text)
                                .fontWeight(active ? .bold : .regular)
                            Spacer()
                            if active {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Palette.primary)
                            }
                        }
                        .optionRow(active: active)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct MultiSelectControl: View {
    let options: [FieldOption]
    @Binding var draft: FieldDraft

    private var selected: [String] {
        if case .multi(let a) = draft { return a }
        return []
    }

    var body: some View {
        if options.isEmpty {
            Text("No options configured.")
                .font(.caption).italic().foregroundStyle(Palette.muted)
        } else {
            VStack(spacing: 8) {
                ForEach(options, id: \.self) { opt in
                    let key = optionKey(opt)
                    let active = selected.contains(key)
                    Button {
                        var next = selected
                        if active { next.removeAll { $0 == key } } else { next.append(key) }
                        draft = .multi(next)
                    } label: {
                        HStack {
                            Image(systemName: active ? "checkmark.square.fill" : "square")
                                .foregroundStyle(active ? Palette.primary : Palette.muted)
                            Text(opt.label)
                                .foregroundStyle(active ? Palette.primary : Palette.text)
                                .fontWeight(active ? .semibold : .regular)
                            Spacer()
                        }
                        .optionRow(active: active)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct RatingControl: View {
    let max: Int
    @Binding var draft: FieldDraft

    private var value: Int {
        if case .rating(let n) = draft { return n }
        return 0
    }

    var body: some View {
        HStack(spacing: 6) {
            ForEach(1...Swift.max(max, 1), id: \.self) { n in
                Button {
                    draft = .rating(n == value ? 0 : n)   // tap the current star to clear
                } label: {
                    Image(systemName: n <= value ? "star.fill" : "star")
                        .font(.title2)
                        .foregroundStyle(n <= value ? Palette.warn : Palette.border)
                }
                .buttonStyle(.plain)
            }
            if value > 0 {
                Text("\(value)/\(max)")
                    .font(.subheadline)
                    .foregroundStyle(Palette.muted)
                    .padding(.leading, 6)
            }
        }
    }
}

// MARK: - FieldDisplayView (read-only, admin inbox)

public struct FieldDisplayView: View {
    public let field: Field
    public let value: JSONValue

    public init(field: Field, value: JSONValue) {
        self.field = field
        self.value = value
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            FieldLabel(field: field)
            display
        }
        .padding(.bottom, 12)
    }

    @ViewBuilder
    private var display: some View {
        if isEmpty(value) {
            Text("—").foregroundStyle(Palette.muted)
        } else {
            switch field.type {
            case .dropdown:
                let key = jsonScalarString(value)
                let label = (field.options ?? []).first { optionKey($0) == key }?.label
                Text(label ?? jsonDisplayString(value)).foregroundStyle(Palette.text)

            case .multiSelect:
                let keys = (value.arrayValue ?? []).map { jsonScalarString($0) }
                let labels = keys.map { k in
                    (field.options ?? []).first { optionKey($0) == k }?.label ?? k
                }
                WrapTags(labels)

            case .checkbox:
                Text((value.boolValue ?? false) ? "Yes" : "No").foregroundStyle(Palette.text)

            case .rating:
                let n = value.intValue ?? 0
                let m = ratingMax(field)
                HStack(spacing: 2) {
                    ForEach(1...Swift.max(m, 1), id: \.self) { i in
                        Image(systemName: i <= n ? "star.fill" : "star")
                            .font(.caption)
                            .foregroundStyle(i <= n ? Palette.warn : Palette.border)
                    }
                    Text("  \(n)/\(m)").font(.caption).foregroundStyle(Palette.muted)
                }

            case .url:
                LinkText(label: jsonScalarString(value), url: jsonScalarString(value))

            case .screenshot, .video:
                let v = jsonScalarString(value)
                let url = v.lowercased().hasPrefix("http") ? v : walrus.blobUrl(v).absoluteString
                LinkText(label: v, url: url)

            case .email, .wallet:
                Text(jsonScalarString(value))
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(Palette.text)
                    .textSelection(.enabled)

            default:
                Text(jsonDisplayString(value)).foregroundStyle(Palette.text)
            }
        }
    }

    private func isEmpty(_ v: JSONValue) -> Bool {
        switch v {
        case .null: return true
        case .string(let s): return s.isEmpty
        case .array(let a): return a.isEmpty
        default: return false
        }
    }
}

// MARK: - Small shared pieces

/// Field label row with a `* required` marker and a `private` badge (matches field-renderer).
struct FieldLabel: View {
    let field: Field
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            // `.foregroundColor` (not `.foregroundStyle`) is the Text-returning overload on
            // iOS 16, which is required for Text concatenation.
            (Text(field.label.isEmpty ? field.id : field.label)
                .foregroundColor(Palette.text)
                + Text(field.required ? " *" : "").foregroundColor(Palette.danger))
                .font(.subheadline.weight(.semibold))
            Spacer(minLength: 8)
            if field.isPrivate {
                Label("private", systemImage: "lock.fill")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Palette.accent)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Palette.accent.opacity(0.12), in: Capsule())
                    .overlay(Capsule().stroke(Palette.accent.opacity(0.4)))
            }
        }
    }
}

/// Shown in fill mode for a `private` field — honest about the Swift Seal boundary (§7).
private struct LockedPrivateNote: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "lock.shield")
                .foregroundStyle(Palette.accent)
            Text("Private (Seal) field — not collected on iOS v1 (no Seal SDK). Omitted from this submission.")
                .font(.caption)
                .foregroundStyle(Palette.muted)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.border))
    }
}

/// A tappable explorer/blob link rendered like the Expo `LinkText`.
struct LinkText: View {
    let label: String
    let url: String
    var body: some View {
        if let u = URL(string: url) {
            Link(destination: u) {
                HStack(spacing: 4) {
                    Text(label).lineLimit(2)
                    Image(systemName: "arrow.up.right")
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.accent)
            }
        } else {
            Text(label).foregroundStyle(Palette.text)
        }
    }
}

/// Simple wrapping tag row for multi-select display values.
struct WrapTags: View {
    let labels: [String]
    init(_ labels: [String]) { self.labels = labels }
    var body: some View {
        // A lightweight wrap via a vertical stack of chips (avoids a custom Layout).
        VStack(alignment: .leading, spacing: 6) {
            ForEach(labels, id: \.self) { l in
                Text(l)
                    .font(.footnote)
                    .foregroundStyle(Palette.text)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.border))
            }
        }
    }
}

// MARK: - Styling

private extension View {
    /// The shared text-field chrome (matches the Expo `input` style).
    func tideformInput() -> some View {
        self
            .foregroundStyle(Palette.text)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.border))
    }

    /// The shared selectable-row chrome (dropdown / multi-select).
    func optionRow(active: Bool) -> some View {
        self
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(
                (active ? Palette.primary.opacity(0.14) : Palette.surface2),
                in: RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(active ? Palette.primary : Palette.border))
    }
}
