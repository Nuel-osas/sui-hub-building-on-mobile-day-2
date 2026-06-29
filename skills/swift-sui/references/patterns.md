# Patterns — reading Move structs in Swift, blob IDs, do/don't

This is the "decode it correctly" file: the `Schema` types, how the on-chain `Form` and
`Submission` structs come back over JSON-RPC, the ASCII `vector<u8>` blob-ID rule, and the
pitfalls that eat a day.

---

## Do / Don't

**Do**
- Read events, objects, and Walrus blobs **directly from the device** — they are public,
  no backend, no cookie.
- Use the `ORIGINAL` package id for `MoveEventType` filters; use the `published-at` package
  id for moveCall **targets**. (Here they're equal at v1, but keep them as two `Env` values
  so an upgrade doesn't silently break event queries.)
- Decode `schema_blob_id` / `blob_id` / `notes_blob_id` as **UTF-8** (`String(decoding:as:)`).
- Treat every u64 (`submitted_at_ms`, `version`, `submissions_count`, `eventSeq`) as a
  **String** in JSON and convert.
- Route privileged writes (sign, sign-message, walrus upload) through the backend over the
  shared cookie session. Route reads straight to public endpoints.
- Surface the **gasless** outcome in the UI after every custodial submit.

**Don't**
- Don't base64-decode blob IDs. They are ASCII bytes of a base64url *string*, not raw bytes.
- Don't generate keys on device in the custodial model — the backend holds them. (Keys
  on device are only the Day-1 zkLogin path.)
- Don't invent SuiKit method names. Tag `// VERIFY: SuiKit API` and keep a `URLSession`
  fallback.
- Don't claim placeholder bytes are Seal encryption. Swift has no Seal SDK — public fields
  only in v1.
- Don't assume `URLSession` keeps cookies by default in a custom config — set
  `httpCookieStorage = .shared` (see `references/zentos-backend.md`).
- Don't decode u64 as `Int` directly from JSON — it arrives quoted.

---

## The ASCII `vector<u8>` blob-ID rule (the #1 pitfall)

On-chain, `schema_blob_id`, `blob_id`, and `notes_blob_id` are
`TextEncoder().encode(blobId)` on the web — i.e. the **UTF-8 bytes of the blob-ID string**.
Over JSON-RPC they come back as an array of numbers (`[UInt8]`).

```swift
enum Blob {
    /// number[] -> blob-ID string. NEVER Data(base64Encoded:) this.
    static func decode(_ bytes: [UInt8]) -> String { String(decoding: bytes, as: UTF8.self) }
    /// blob-ID string -> number[] for a pure.vector<u8> argument.
    static func encode(_ s: String) -> [UInt8] { Array(s.utf8) }
}

// ✅ correct
let blobId = Blob.decode(form.schema_blob_id)          // "-Hn2...Qk"  (a base64url string)
// ❌ wrong — corrupts the id
// let blobId = Data(form.schema_blob_id)               // raw bytes, not what you want
// let blobId = Data(base64Encoded: ...)               // these are not base64-encoded bytes
```

---

## Reading the `Form` Move struct

Field mapping from source-of-truth §3.1 / §4. Over `sui_getObject` with
`options.showContent`, the struct lives at `data.content.fields`.

```swift
import Foundation

/// u64s arrive as quoted strings; decode flexibly.
struct U64String: Codable {
    let value: UInt64
    init(from d: Decoder) throws {
        let c = try d.singleValueContainer()
        if let s = try? c.decode(String.self), let v = UInt64(s) { value = v }
        else { value = try c.decode(UInt64.self) }
    }
    func encode(to e: Encoder) throws { var c = e.singleValueContainer(); try c.encode(String(value)) }
}

/// Raw decoded fields of Form (matches Move struct order/names).
struct FormFields: Decodable {
    let owner: String
    let admins: AdminsWrap?            // VecSet<address> -> { fields: { contents: [address] } }
    let schema_blob_id: [UInt8]        // ASCII vector<u8>
    let version: U64String
    let status: Int                    // u8: 0 OPEN, 1 CLOSED, 2 ARCHIVED
    let submissions_count: U64String
    let require_wallet: Bool
    let one_per_wallet: Bool
    let created_at_ms: U64String
    let updated_at_ms: U64String

    struct AdminsWrap: Decodable {
        struct Inner: Decodable { let contents: [String] }
        let fields: Inner
    }
}

/// Domain model.
struct Form: Identifiable {
    let id: String
    let owner: String
    let admins: [String]
    let schemaBlobId: String
    let version: UInt64
    let status: Int
    let submissionsCount: UInt64
    let requireWallet: Bool
    let onePerWallet: Bool

    init(objectId: String, fields: FormFields) {
        id = objectId
        owner = fields.owner
        admins = fields.admins?.fields.contents ?? []
        schemaBlobId = Blob.decode(fields.schema_blob_id)
        version = fields.version.value
        status = fields.status
        submissionsCount = fields.submissions_count.value
        requireWallet = fields.require_wallet
        onePerWallet = fields.one_per_wallet
    }

    var isAdmin: Bool { false } // helper; fill against current user when needed
}
```

> `MoveContent.fields` in `references/suikit.md` is typed `FormFields?` for brevity. In a
> real app make `MoveContent` generic (`MoveContent<F: Decodable>`) or decode the `fields`
> object twice (once as `FormFields`, once as `SubmissionFields`) depending on `type`.

---

## Reading the `Submission` Move struct (the on-chain object)

Source-of-truth §3.2 / §4. Note: this **on-chain object** is distinct from the §8
`Submission` JSON payload below — they share a name on the web. Here the object is
`SubmissionObject`, the payload is `Submission`.

```swift
struct SubmissionFields: Decodable {
    let form_id: String
    let blob_id: [UInt8]              // ASCII vector<u8>
    let submitter: String
    let submitted_at_ms: U64String
    let status: Int                  // 0 NEW, 1 IN_PROGRESS, 2 RESOLVED, 3 SPAM
    let priority: Int                // 0 LOW, 1 MED, 2 HIGH, 3 URGENT
    let tags: [String]
    let has_notes: Bool
    let notes_blob_id: [UInt8]
}

struct SubmissionObject: Identifiable {
    let id: String
    let formId: String
    let blobId: String
    let submitter: String
    let submittedAtMs: UInt64
    let status: Int
    let priority: Int
    let tags: [String]
    let hasNotes: Bool
    let notesBlobId: String?

    init?(objectId: String, content: MoveContent?) {
        guard let raw = content?.rawFields,
              let f = try? JSONDecoder().decode(SubmissionFields.self, from: raw) else { return nil }
        id = objectId
        formId = f.form_id
        blobId = Blob.decode(f.blob_id)
        submitter = f.submitter
        submittedAtMs = f.submitted_at_ms.value
        status = f.status
        priority = f.priority
        tags = f.tags
        hasNotes = f.has_notes
        notesBlobId = f.has_notes ? Blob.decode(f.notes_blob_id) : nil
    }
}
```

### `querySubmissionIds` — SubmissionReceived filtered by form

```swift
struct SubmissionReceivedJson: Decodable {
    let form_id: String
    let submission_id: String
    let blob_id: [UInt8]
    let submitter: String
    let submitted_at_ms: U64String
}

extension SuiRPC {
    func querySubmissionIds(formId: String) async throws -> [String] {
        // There is no native "by field" event filter for an inner ID; query the event type
        // and filter client-side on parsedJson.form_id. (For high volume, page through.)
        struct Page: Decodable { let data: [Env]; let hasNextPage: Bool; let nextCursor: EventId?
            struct Env: Decodable { let parsedJson: SubmissionReceivedJson } }
        var ids: [String] = []
        var cursor: EventId? = nil
        repeat {
            let filter: [String: Any] = ["MoveEventType": "\(Env.originalPackageId)::events::SubmissionReceived"]
            let page: Page = try await call("suix_queryEvents", [filter, cursor as Any, 50, true])
            ids += page.data.filter { $0.parsedJson.form_id == formId }.map { $0.parsedJson.submission_id }
            cursor = page.hasNextPage ? page.nextCursor : nil
        } while cursor != nil
        return ids
    }
}
```

(Add `var rawFields: Data?` to `MoveContent` — keep the original `fields` JSON so you can
re-decode it as the right struct per `type`. e.g. store it during decode with a
`KeyedDecodingContainer` capture, or decode `content` as `[String: AnyCodable]` and pull
`fields`.)

---

## The `Schema` types (source-of-truth §8) — `Lib/Schema.swift`

These are the `FieldType`, `Field`, `FormSchema`, `Submission`, `FieldValue` from the Lib
surface. The §8 `Submission` here is the **JSON payload** uploaded to Walrus (not the
on-chain object above).

```swift
import Foundation

enum FieldType: String, Codable {
    case shortText   = "short_text"
    case longText    = "long_text"
    case richText    = "rich_text"
    case dropdown
    case multiSelect = "multi_select"
    case checkbox
    case rating
    case screenshot
    case video
    case url
    case number
    case date
    case email
    case wallet
}

struct FieldOption: Codable, Hashable { let label: String; let value: String }

struct Field: Codable, Identifiable {
    let id: String
    let type: FieldType
    let label: String
    var help: String?
    var placeholder: String?
    var required: Bool
    var `private`: Bool          // `private` is a keyword — backtick-escape it
    var defaultValue: AnyCodable?
    var options: [FieldOption]?
    // validation / conditional omitted for brevity; add as AnyCodable if needed
}

struct FormSection: Codable, Identifiable { let id: String; var title: String?; let fields: [Field] }

struct FormTheme: Codable { let primary: String?; let mode: String? }
struct FormSettings: Codable {
    var requireWallet: Bool?
    var onePerWallet: Bool?
    var captcha: Bool?
    var successMessage: String?
    var style: String?           // "compact" | "conversational"
    var redirectUrl: String?
}

struct FormSchema: Codable {
    let version: Int?
    let formVersion: Int?
    let title: String
    var description: String?
    var bannerBlobId: String?
    var theme: FormTheme?
    var settings: FormSettings?
    let sections: [FormSection]
}

// ---- Submission JSON payload (uploaded to Walrus; its blob_id is the submit() arg) ----

struct Submission: Codable {
    let formId: String
    let formVersion: Int?
    let submittedAt: String        // ISO 8601
    var submitter: String?
    let fields: [String: FieldValue]
}

/// FieldValue is a tagged union keyed on `kind`.
enum FieldValue: Codable {
    case plaintext(value: AnyCodable)
    case media(blobId: String, mime: String, bytes: Int, name: String)
    case encrypted(envelope: SealEnvelope)             // Swift can READ these; cannot decrypt (no Seal SDK)
    case encryptedMedia(blobId: String, sealId: String, mime: String, bytes: Int, name: String)

    enum CodingKeys: String, CodingKey {
        case kind, value, blobId, mime, bytes, name, envelope, sealId
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "plaintext":
            self = .plaintext(value: try c.decode(AnyCodable.self, forKey: .value))
        case "media":
            self = .media(blobId: try c.decode(String.self, forKey: .blobId),
                          mime: try c.decode(String.self, forKey: .mime),
                          bytes: try c.decode(Int.self, forKey: .bytes),
                          name: try c.decode(String.self, forKey: .name))
        case "encrypted":
            self = .encrypted(envelope: try c.decode(SealEnvelope.self, forKey: .envelope))
        case "encrypted-media":
            self = .encryptedMedia(blobId: try c.decode(String.self, forKey: .blobId),
                                   sealId: try c.decode(String.self, forKey: .sealId),
                                   mime: try c.decode(String.self, forKey: .mime),
                                   bytes: try c.decode(Int.self, forKey: .bytes),
                                   name: try c.decode(String.self, forKey: .name))
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown FieldValue kind")
        }
    }

    func encode(to e: Encoder) throws {
        var c = e.container(keyedBy: CodingKeys.self)
        switch self {
        case .plaintext(let v):
            try c.encode("plaintext", forKey: .kind); try c.encode(v, forKey: .value)
        case .media(let b, let m, let by, let n):
            try c.encode("media", forKey: .kind); try c.encode(b, forKey: .blobId)
            try c.encode(m, forKey: .mime); try c.encode(by, forKey: .bytes); try c.encode(n, forKey: .name)
        case .encrypted(let env):
            try c.encode("encrypted", forKey: .kind); try c.encode(env, forKey: .envelope)
        case .encryptedMedia(let b, let s, let m, let by, let n):
            try c.encode("encrypted-media", forKey: .kind); try c.encode(b, forKey: .blobId)
            try c.encode(s, forKey: .sealId); try c.encode(m, forKey: .mime)
            try c.encode(by, forKey: .bytes); try c.encode(n, forKey: .name)
        }
    }
}

/// Seal envelope (read-only on Swift). mode "seal" = real; "placeholder" = NOT encryption.
struct SealEnvelope: Codable { let mode: String; let b64: String; var id: String? }
```

A tiny `AnyCodable` (enough for plaintext field values):

```swift
struct AnyCodable: Codable {
    let value: Any
    init(_ v: Any) { value = v }
    init(from d: Decoder) throws {
        let c = try d.singleValueContainer()
        if let v = try? c.decode(Bool.self) { value = v }
        else if let v = try? c.decode(Int.self) { value = v }
        else if let v = try? c.decode(Double.self) { value = v }
        else if let v = try? c.decode(String.self) { value = v }
        else if let v = try? c.decode([AnyCodable].self) { value = v.map { $0.value } }
        else if let v = try? c.decode([String: AnyCodable].self) { value = v.mapValues { $0.value } }
        else if c.decodeNil() { value = NSNull() }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported AnyCodable") }
    }
    func encode(to e: Encoder) throws {
        var c = e.singleValueContainer()
        switch value {
        case let v as Bool: try c.encode(v)
        case let v as Int: try c.encode(v)
        case let v as Double: try c.encode(v)
        case let v as String: try c.encode(v)
        case let v as [Any]: try c.encode(v.map { AnyCodable($0) })
        case let v as [String: Any]: try c.encode(v.mapValues { AnyCodable($0) })
        case is NSNull: try c.encodeNil()
        default: try c.encodeNil()
        }
    }
}
```

---

## Building a `Submission` payload to submit (public fields)

```swift
func makeSubmission(formId: String, formVersion: Int?, values: [String: Any]) -> Submission {
    var fields: [String: FieldValue] = [:]
    for (id, v) in values {
        fields[id] = .plaintext(value: AnyCodable(v))   // public fields only in v1
        // For `private` fields: skip, or backend-delegate Seal encryption (see SKILL.md).
    }
    return Submission(
        formId: formId,
        formVersion: formVersion,
        submittedAt: ISO8601DateFormatter().string(from: Date()),
        submitter: nil,
        fields: fields
    )
}
```

Then: `Walrus.uploadJson(submission, owner: address)` → `Move.txSubmit(formId:blobId:)`
→ `ZentosClient.signAndExecuteCustodial(&tx, address:)`. Gasless, popup-less.

---

## Pitfall checklist

- **Cookie not sent** → you used `URLSession.shared` for some calls and `ZentosSession.shared`
  for others, or a config without `.shared` cookie storage. Use one session everywhere.
- **`aud` mismatch on login** → backend doesn't trust the iOS OAuth client id. See SKILL.md.
- **u64 decode crash** → you decoded `submitted_at_ms` as `Int`; it's a quoted string. Use `U64String`.
- **Garbled blob ID** → you base64-decoded an ASCII `vector<u8>`. Use `Blob.decode` (UTF-8).
- **Empty "my forms"** → wrong package id in the `MoveEventType` filter (use `originalPackageId`)
  or you filtered `owner` before lower/upper-casing — Sui addresses are already normalized
  `0x…` lowercased, so compare exactly.
- **`build(onlyTransactionKind:)` not found** → real SuiKit gap; see `references/suikit.md`
  §4 fallback. Don't invent a method.
- **Seal "works"** → it doesn't on Swift. If you see encrypted output, it's placeholder, not
  real. Public fields only in v1.
