//
//  Indexer.swift
//  Tideform · Lib layer
//
//  Read-side glue, mirroring the Expo `lib/indexer.ts` surface:
//    listFormsForOwner(addr), fetchForm(id), fetchFormSchema(blobId),
//    listSubmissions(formId), fetchSubmissionPayload(blobId)
//
//  Pattern (source-of-truth §9): query origin-package events -> multiGetObjects ->
//  decode Move struct fields -> read the referenced Walrus blobs. All on-device,
//  no backend, no auth.
//
//  Blob IDs in `schema_blob_id` / `blob_id` are `vector<u8>` of ASCII bytes — decoded
//  with UTF-8 here (source-of-truth §4/§12), never base64.
//

import Foundation

// MARK: - On-chain object models (distinct from the JSON `Submission` payload in Schema.swift)

/// Decoded `tideform::form::Form` object (mirrors the Expo `FormObject`; named to
/// avoid shadowing `SwiftUI.Form` in the UI layer and to match the sibling `SubmissionObject`).
public struct FormObject: Sendable, Identifiable {
    public let id: String
    public let owner: String
    public let admins: [String]
    /// ASCII-decoded Walrus blob ID of the form's `FormSchema` JSON.
    public let schemaBlobId: String
    public let version: UInt64
    public let status: UInt8          // 0 OPEN · 1 CLOSED · 2 ARCHIVED
    public let submissionsCount: UInt64
    public let requireWallet: Bool
    public let onePerWallet: Bool
    public let createdAtMs: UInt64
    public let updatedAtMs: UInt64
}

/// Decoded `tideform::submission::Submission` object.
public struct SubmissionObject: Sendable, Identifiable {
    public let id: String
    public let formId: String
    /// ASCII-decoded Walrus blob ID of the submission's `Submission` JSON payload.
    public let blobId: String
    public let submitter: String
    public let submittedAtMs: UInt64
    public let status: UInt8          // 0 NEW · 1 IN_PROGRESS · 2 RESOLVED · 3 SPAM
    public let priority: UInt8        // 0 LOW · 1 MED · 2 HIGH · 3 URGENT
    public let tags: [String]
    public let hasNotes: Bool
    /// ASCII-decoded Walrus blob ID of the admin notes (empty when `hasNotes == false`).
    public let notesBlobId: String
}

public enum IndexerError: Error, CustomStringConvertible {
    case notFound(String)
    case malformed(String)

    public var description: String {
        switch self {
        case .notFound(let s): return "Not found: \(s)"
        case .malformed(let s): return "Malformed object: \(s)"
        }
    }
}

public final class Indexer: @unchecked Sendable {

    public static let shared = Indexer()

    private let sui: SuiClient
    private let walrus: Walrus

    public init(sui: SuiClient = .shared, walrus: Walrus = .shared) {
        self.sui = sui
        self.walrus = walrus
    }

    // Event types are queried against the ORIGINAL package id (type-origin is upgrade-stable).
    private var formCreatedType: String { "\(env.originalPackageId)::events::FormCreated" }
    private var submissionReceivedType: String {
        "\(env.originalPackageId)::events::SubmissionReceived"
    }

    // MARK: - Forms

    /// Forms owned by `owner`: FormCreated events filtered by owner -> multiGetObjects.
    public func listFormsForOwner(_ owner: String) async throws -> [FormObject] {
        let target = Indexer.normalizeAddress(owner)
        let events = try await sui.queryAllEvents(eventType: formCreatedType)

        // Preserve newest-first order while de-duping form ids.
        var seen = Set<String>()
        var formIds: [String] = []
        for ev in events {
            guard
                let pj = ev.parsedJson,
                Indexer.normalizeAddress(pj["owner"]?.stringValue ?? "") == target,
                let fid = pj["form_id"]?.stringValue
            else { continue }
            if seen.insert(fid).inserted { formIds.append(fid) }
        }
        guard !formIds.isEmpty else { return [] }

        let responses = try await multiGetChunked(formIds)
        return responses.compactMap { Indexer.parseForm($0) }
    }

    /// Fetch and decode a single Form object.
    public func fetchForm(_ id: String) async throws -> FormObject {
        let response = try await sui.getObject(id: id)
        guard let form = Indexer.parseForm(response) else {
            throw IndexerError.notFound("Form \(id)")
        }
        return form
    }

    /// Read a form's `FormSchema` JSON from Walrus by its (ASCII) blob ID.
    public func fetchFormSchema(_ blobId: String) async throws -> FormSchema {
        try await walrus.readJson(FormSchema.self, id: blobId)
    }

    // MARK: - Submissions

    /// Submissions for a form: SubmissionReceived events filtered by form_id -> multiGetObjects.
    public func listSubmissions(_ formId: String) async throws -> [SubmissionObject] {
        let target = Indexer.normalizeAddress(formId)
        let events = try await sui.queryAllEvents(eventType: submissionReceivedType)

        var seen = Set<String>()
        var ids: [String] = []
        for ev in events {
            guard
                let pj = ev.parsedJson,
                Indexer.normalizeAddress(pj["form_id"]?.stringValue ?? "") == target,
                let sid = pj["submission_id"]?.stringValue
            else { continue }
            if seen.insert(sid).inserted { ids.append(sid) }
        }
        guard !ids.isEmpty else { return [] }

        let responses = try await multiGetChunked(ids)
        return responses.compactMap { Indexer.parseSubmission($0) }
    }

    /// `sui_multiGetObjects` caps at ~50 ids per call; chunk to stay under it
    /// (mirrors the Expo `MULTIGET_CHUNK = 50`).
    private func multiGetChunked(_ ids: [String], chunk: Int = 50) async throws
        -> [SuiObjectResponse]
    {
        var out: [SuiObjectResponse] = []
        var i = 0
        while i < ids.count {
            let slice = Array(ids[i..<min(i + chunk, ids.count)])
            out.append(contentsOf: try await sui.multiGetObjects(ids: slice))
            i += chunk
        }
        return out
    }

    /// Read a submission's `Submission` JSON payload from Walrus by its (ASCII) blob ID.
    public func fetchSubmissionPayload(_ blobId: String) async throws -> Submission {
        try await walrus.readJson(Submission.self, id: blobId)
    }

    // MARK: - Move struct parsing

    static func parseForm(_ response: SuiObjectResponse) -> FormObject? {
        guard let data = response.data, let fields = data.content?.fields else { return nil }
        guard
            let owner = fields["owner"]?.stringValue,
            let schemaBlobId = decodeAsciiBlob(fields["schema_blob_id"])
        else { return nil }

        return FormObject(
            id: data.objectId,
            owner: owner,
            admins: parseAddressSet(fields["admins"]),
            schemaBlobId: schemaBlobId,
            version: fields["version"]?.uint64Value ?? 0,
            status: fields["status"]?.uint8Value ?? 0,
            submissionsCount: fields["submissions_count"]?.uint64Value ?? 0,
            requireWallet: fields["require_wallet"]?.boolValue ?? false,
            onePerWallet: fields["one_per_wallet"]?.boolValue ?? false,
            createdAtMs: fields["created_at_ms"]?.uint64Value ?? 0,
            updatedAtMs: fields["updated_at_ms"]?.uint64Value ?? 0)
    }

    static func parseSubmission(_ response: SuiObjectResponse) -> SubmissionObject? {
        guard let data = response.data, let fields = data.content?.fields else { return nil }
        guard
            let formId = fields["form_id"]?.stringValue,
            let blobId = decodeAsciiBlob(fields["blob_id"]),
            let submitter = fields["submitter"]?.stringValue
        else { return nil }

        return SubmissionObject(
            id: data.objectId,
            formId: formId,
            blobId: blobId,
            submitter: submitter,
            submittedAtMs: fields["submitted_at_ms"]?.uint64Value ?? 0,
            status: fields["status"]?.uint8Value ?? 0,
            priority: fields["priority"]?.uint8Value ?? 0,
            tags: parseStringVector(fields["tags"]),
            hasNotes: fields["has_notes"]?.boolValue ?? false,
            notesBlobId: decodeAsciiBlob(fields["notes_blob_id"]) ?? "")
    }

    /// `VecSet<address>` renders as `{ "fields": { "contents": ["0x..", ...] } }`
    /// (source-of-truth §4: `f.admins.fields.contents`). Falls back to a direct array.
    static func parseAddressSet(_ value: JSONValue?) -> [String] {
        guard let value else { return [] }
        if let contents = value["fields"]?["contents"]?.arrayValue {
            return contents.compactMap { $0.stringValue }
        }
        if let arr = value.arrayValue {
            return arr.compactMap { $0.stringValue }
        }
        return []
    }

    static func parseStringVector(_ value: JSONValue?) -> [String] {
        value?.arrayValue?.compactMap { $0.stringValue } ?? []
    }

    /// Decode a Move `vector<u8>` blob-ID field to its ASCII string (source-of-truth §4/§12).
    static func decodeAsciiBlob(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        // Primary path: fullnode renders `vector<u8>` as a JSON number array.
        if let bytes = value.byteArrayValue {
            return bytes.isEmpty ? "" : String(decoding: bytes, as: UTF8.self)
        }
        // Defensive: some setups render `vector<u8>` as a base64 string; the underlying
        // bytes are the ASCII blob ID. (Blob IDs are base64URL, which standard base64
        // decoding rejects -> we fall through and return the string unchanged.)
        if let s = value.stringValue {
            if let decoded = Data(base64Encoded: s),
                let str = String(data: decoded, encoding: .utf8), !str.isEmpty
            {
                return str
            }
            return s
        }
        return nil
    }

    /// Lowercase for case-insensitive address/ID comparison. Fullnode returns full-length
    /// 0x-padded addresses, matching the values from `/api/auth/me`.
    static func normalizeAddress(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

/// Module-level alias mirroring the JS `indexer` singleton (`indexer.listFormsForOwner(...)`).
public let indexer = Indexer.shared
