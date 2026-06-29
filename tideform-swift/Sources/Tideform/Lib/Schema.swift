//
//  Schema.swift
//  Tideform · Lib layer
//
//  Codable form-schema + submission types, mirroring the Expo `lib/schema.ts`
//  surface (architecture source-of-truth §8). Exposes:
//    FieldType, Field, FormSchema, Submission, FieldValue (+ supporting JSONValue).
//
//  These are the *application JSON* shapes that get uploaded to / read from Walrus.
//  The on-chain Move object shapes (Form / Submission objects) live in Indexer.swift.
//

import Foundation

// MARK: - JSONValue
//
// A tolerant JSON container used wherever the wire shape is open-ended:
//   - schema `defaultValue` / `validation` / `conditional`
//   - Sui JSON-RPC `parsedJson` (events) and Move object `content.fields`
//   - Walrus blobs read as untyped JSON
//
// It is intentionally lossless and provides ergonomic, optional accessors so the
// Indexer can walk Move struct fields like `fields["admins"]["fields"]["contents"]`.

public enum JSONValue: Codable, Equatable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        // Order matters: Bool before Double so JSON `true`/`false` don't become 1/0.
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let d = try? c.decode(Double.self) { self = .number(d); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(
            in: c, debugDescription: "Unsupported JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    // MARK: Ergonomic accessors

    public subscript(_ key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public subscript(_ index: Int) -> JSONValue? {
        if case .array(let a) = self, a.indices.contains(index) { return a[index] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var boolValue: Bool? {
        switch self {
        case .bool(let b): return b
        case .string(let s): return Bool(s)
        case .number(let n): return n != 0
        default: return nil
        }
    }

    public var doubleValue: Double? {
        switch self {
        case .number(let n): return n
        case .string(let s): return Double(s)
        default: return nil
        }
    }

    public var intValue: Int? { doubleValue.map { Int($0) } }

    /// u64/u128 Move fields are serialized by the fullnode as decimal *strings*.
    public var uint64Value: UInt64? {
        switch self {
        case .number(let n): return n >= 0 ? UInt64(n) : nil
        case .string(let s): return UInt64(s)
        default: return nil
        }
    }

    public var uint8Value: UInt8? {
        switch self {
        case .number(let n): return (n >= 0 && n <= 255) ? UInt8(n) : nil
        case .string(let s): return UInt8(s)
        default: return nil
        }
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    /// Interprets `self` as a Move `vector<u8>` rendered as a JSON array of numbers.
    public var byteArrayValue: [UInt8]? {
        guard case .array(let a) = self else { return nil }
        var out: [UInt8] = []
        out.reserveCapacity(a.count)
        for el in a {
            guard let b = el.uint8Value else { return nil }
            out.append(b)
        }
        return out
    }
}

// MARK: - FieldType (14 types, source-of-truth §8)

public enum FieldType: String, Codable, CaseIterable, Sendable {
    case shortText = "short_text"
    case longText = "long_text"
    case richText = "rich_text"
    case dropdown = "dropdown"
    case multiSelect = "multi_select"
    case checkbox = "checkbox"
    case rating = "rating"
    case screenshot = "screenshot"
    case video = "video"
    case url = "url"
    case number = "number"
    case date = "date"
    case email = "email"
    case wallet = "wallet"
}

// MARK: - FieldOption
//
// Options are authored either as plain strings or as `{ label, value }` objects.
// Decode tolerantly so both shapes render in a dropdown / multi-select.

public struct FieldOption: Codable, Sendable, Hashable {
    // Mirrors the Expo/brief §8 FieldOption: { id, label, value }. `id` is optional
    // because the plain-string option form ("Red") carries no id.
    public let id: String?
    public let label: String
    public let value: JSONValue

    public init(id: String? = nil, label: String, value: JSONValue) {
        self.id = id
        self.label = label
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        // Plain string form: "Red" -> label "Red", value "Red".
        if let single = try? decoder.singleValueContainer(), let s = try? single.decode(String.self) {
            self.id = nil
            self.label = s
            self.value = .string(s)
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try? c.decode(String.self, forKey: .id)
        let value = (try? c.decode(JSONValue.self, forKey: .value)) ?? .null
        let label = (try? c.decode(String.self, forKey: .label))
            ?? value.stringValue
            ?? ""
        self.label = label
        self.value = value
    }

    private enum CodingKeys: String, CodingKey { case id, label, value }
}

// MARK: - Field

public struct Field: Codable, Sendable, Identifiable {
    public let id: String
    public let type: FieldType
    public let label: String
    public let help: String?
    public let placeholder: String?
    public let required: Bool
    /// Maps the JSON key `private`. Private fields are Seal-encrypted at submit time.
    public let isPrivate: Bool
    public let defaultValue: JSONValue?
    public let validation: JSONValue?
    public let options: [FieldOption]?
    public let conditional: JSONValue?

    private enum CodingKeys: String, CodingKey {
        case id, type, label, help, placeholder, required
        case isPrivate = "private"
        case defaultValue, validation, options, conditional
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.type = try c.decode(FieldType.self, forKey: .type)
        self.label = (try? c.decode(String.self, forKey: .label)) ?? ""
        self.help = try? c.decode(String.self, forKey: .help)
        self.placeholder = try? c.decode(String.self, forKey: .placeholder)
        self.required = (try? c.decode(Bool.self, forKey: .required)) ?? false
        self.isPrivate = (try? c.decode(Bool.self, forKey: .isPrivate)) ?? false
        self.defaultValue = try? c.decode(JSONValue.self, forKey: .defaultValue)
        self.validation = try? c.decode(JSONValue.self, forKey: .validation)
        self.options = try? c.decode([FieldOption].self, forKey: .options)
        self.conditional = try? c.decode(JSONValue.self, forKey: .conditional)
    }

    public init(
        id: String, type: FieldType, label: String, help: String? = nil,
        placeholder: String? = nil, required: Bool = false, isPrivate: Bool = false,
        defaultValue: JSONValue? = nil, validation: JSONValue? = nil,
        options: [FieldOption]? = nil, conditional: JSONValue? = nil
    ) {
        self.id = id; self.type = type; self.label = label; self.help = help
        self.placeholder = placeholder; self.required = required; self.isPrivate = isPrivate
        self.defaultValue = defaultValue; self.validation = validation
        self.options = options; self.conditional = conditional
    }
}

// MARK: - FormSchema

public struct FormSchema: Codable, Sendable {
    /// Schema container version (open-ended; number or string).
    public let version: JSONValue?
    /// The form's content version — bumped on schema edits.
    public let formVersion: JSONValue?
    public let title: String
    public let description: String?
    public let bannerBlobId: String?
    public let theme: Theme?
    public let settings: Settings?
    public let sections: [Section]

    public var formVersionInt: Int? { formVersion?.intValue }

    public struct Theme: Codable, Sendable {
        public let primary: String?
        public let mode: String?
    }

    public struct Settings: Codable, Sendable {
        public let requireWallet: Bool?
        public let onePerWallet: Bool?
        public let captcha: Bool?
        public let successMessage: String?
        /// "compact" | "conversational"
        public let style: String?
        public let redirectUrl: String?
    }

    public struct Section: Codable, Sendable, Identifiable {
        public let id: String
        public let title: String?
        public let fields: [Field]
    }

    /// Flattened view of every field across sections, in order.
    public var allFields: [Field] { sections.flatMap { $0.fields } }
}

// MARK: - SealEnvelope

public struct SealEnvelope: Codable, Sendable {
    /// "seal" (real Seal ciphertext) or "placeholder" (never real encryption).
    public let mode: String
    public let b64: String
    public let id: String?

    public init(mode: String, b64: String, id: String? = nil) {
        self.mode = mode; self.b64 = b64; self.id = id
    }
}

// MARK: - FieldValue
//
// Discriminated union keyed on `kind`. Mirrors source-of-truth §8.

public enum FieldValue: Codable, Sendable {
    case plaintext(value: JSONValue)
    case media(blobId: String, mime: String, bytes: Int, name: String)
    case encrypted(envelope: SealEnvelope)
    case encryptedMedia(blobId: String, sealId: String, mime: String, bytes: Int, name: String)

    private enum CodingKeys: String, CodingKey {
        case kind, value, blobId, mime, bytes, name, envelope, sealId
    }

    private enum Kind: String {
        case plaintext
        case media
        case encrypted
        case encryptedMedia = "encrypted-media"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try c.decode(String.self, forKey: .kind)
        guard let kind = Kind(rawValue: raw) else {
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: c, debugDescription: "Unknown FieldValue kind: \(raw)")
        }
        switch kind {
        case .plaintext:
            self = .plaintext(value: (try? c.decode(JSONValue.self, forKey: .value)) ?? .null)
        case .media:
            self = .media(
                blobId: try c.decode(String.self, forKey: .blobId),
                mime: try c.decode(String.self, forKey: .mime),
                bytes: (try? c.decode(Int.self, forKey: .bytes)) ?? 0,
                name: (try? c.decode(String.self, forKey: .name)) ?? "")
        case .encrypted:
            self = .encrypted(envelope: try c.decode(SealEnvelope.self, forKey: .envelope))
        case .encryptedMedia:
            self = .encryptedMedia(
                blobId: try c.decode(String.self, forKey: .blobId),
                sealId: try c.decode(String.self, forKey: .sealId),
                mime: try c.decode(String.self, forKey: .mime),
                bytes: (try? c.decode(Int.self, forKey: .bytes)) ?? 0,
                name: (try? c.decode(String.self, forKey: .name)) ?? "")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .plaintext(let value):
            try c.encode(Kind.plaintext.rawValue, forKey: .kind)
            try c.encode(value, forKey: .value)
        case .media(let blobId, let mime, let bytes, let name):
            try c.encode(Kind.media.rawValue, forKey: .kind)
            try c.encode(blobId, forKey: .blobId)
            try c.encode(mime, forKey: .mime)
            try c.encode(bytes, forKey: .bytes)
            try c.encode(name, forKey: .name)
        case .encrypted(let envelope):
            try c.encode(Kind.encrypted.rawValue, forKey: .kind)
            try c.encode(envelope, forKey: .envelope)
        case .encryptedMedia(let blobId, let sealId, let mime, let bytes, let name):
            try c.encode(Kind.encryptedMedia.rawValue, forKey: .kind)
            try c.encode(blobId, forKey: .blobId)
            try c.encode(sealId, forKey: .sealId)
            try c.encode(mime, forKey: .mime)
            try c.encode(bytes, forKey: .bytes)
            try c.encode(name, forKey: .name)
        }
    }
}

// MARK: - Submission (application JSON payload)

public struct Submission: Codable, Sendable {
    public let formId: String
    public let formVersion: JSONValue?
    /// ISO-8601 timestamp.
    public let submittedAt: String
    public let submitter: String?
    public let fields: [String: FieldValue]

    public init(
        formId: String, formVersion: JSONValue? = nil, submittedAt: String,
        submitter: String? = nil, fields: [String: FieldValue]
    ) {
        self.formId = formId; self.formVersion = formVersion
        self.submittedAt = submittedAt; self.submitter = submitter; self.fields = fields
    }
}
