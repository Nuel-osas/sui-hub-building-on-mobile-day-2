//
//  Walrus.swift
//  Tideform · Lib layer
//
//  Walrus blob I/O, mirroring the Expo `lib/walrus.ts` surface:
//    readBlob(id), readJson(id), uploadBlob(bytes,{owner}), uploadJson(obj,{owner}), blobUrl(id)
//
//  READS  — public aggregator, no auth, straight from the device (source-of-truth §5).
//  WRITES — sponsored via the Zentos backend `POST /api/walrus/upload` (multipart);
//           the user pays zero WAL/SUI and the sponsor API key never reaches the client.
//
//  IMPORTANT: the returned `blobId` is an ASCII string. It is stored on-chain as
//  `vector<u8>` of its ASCII bytes (Move.swift encodes it that way) — never base64.
//

import Foundation

public enum WalrusError: Error, CustomStringConvertible {
    case http(status: Int, body: String)
    case badResponse(String)

    public var description: String {
        switch self {
        case .http(let s, let b): return "Walrus HTTP \(s): \(b)"
        case .badResponse(let m): return "Walrus bad response: \(m)"
        }
    }
}

/// Result of a sponsored upload (`POST /api/walrus/upload`). `blobId` is what you
/// store on-chain.
public struct WalrusUploadResult: Decodable, Sendable {
    public let blobId: String
    public let sponsoredBlobId: String?
    public let txDigest: String?
    public let endEpoch: Int?
    public let walCost: JSONValue?

    private enum CodingKeys: String, CodingKey {
        case blobId = "blob_id"
        case sponsoredBlobId = "sponsored_blob_id"
        case txDigest = "tx_digest"
        case endEpoch = "end_epoch"
        case walCost = "wal_cost"
    }
}

public final class Walrus: @unchecked Sendable {

    public static let shared = Walrus()

    private let aggregator: String
    private let backendBaseUrl: String
    /// Cookie-aware session so the sponsored upload carries the Zentos session cookie.
    private let session: URLSession

    public init(
        aggregator: String = env.walrusAggregator,
        backendBaseUrl: String = env.backendBaseUrl,
        session: URLSession = tideformURLSession
    ) {
        self.aggregator = aggregator.hasSuffix("/") ? String(aggregator.dropLast()) : aggregator
        self.backendBaseUrl =
            backendBaseUrl.hasSuffix("/") ? String(backendBaseUrl.dropLast()) : backendBaseUrl
        self.session = session
    }

    // MARK: - Reads (public aggregator)

    /// Public read URL for a blob — useful for AsyncImage / direct linking.
    public func blobUrl(_ id: String) -> URL {
        URL(string: "\(aggregator)/v1/blobs/\(id)")!
    }

    /// Raw blob bytes.
    public func readBlob(_ id: String) async throws -> Data {
        let (data, response) = try await session.data(from: blobUrl(id))
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw WalrusError.http(
                status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    /// Decode a blob as JSON into a concrete `Decodable` (e.g. `FormSchema`, `Submission`).
    public func readJson<T: Decodable>(_ type: T.Type = T.self, id: String) async throws -> T {
        let data = try await readBlob(id)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Decode a blob as untyped JSON.
    public func readJson(id: String) async throws -> JSONValue {
        let data = try await readBlob(id)
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    // MARK: - Writes (sponsored, via backend)

    /// Upload raw bytes through the sponsored backend route. Returns the on-chain `blobId`.
    /// `owner` is the user's Sui address (`creator_address`).
    @discardableResult
    public func uploadBlob(
        _ bytes: Data,
        owner: String,
        epochs: Int = 5,
        deletable: Bool = true,
        filename: String = "blob.bin",
        contentType: String = "application/octet-stream"
    ) async throws -> WalrusUploadResult {
        let url = URL(string: "\(backendBaseUrl)/api/walrus/upload")!
        let boundary = "Boundary-\(UUID().uuidString)"

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(
            "multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = Walrus.multipartBody(
            boundary: boundary,
            fields: [
                "creator_address": owner,
                "epochs": String(epochs),
                "deletable": deletable ? "true" : "false",
            ],
            fileField: "file",
            filename: filename,
            contentType: contentType,
            fileData: bytes)

        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw WalrusError.http(
                status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
        do {
            return try JSONDecoder().decode(WalrusUploadResult.self, from: data)
        } catch {
            throw WalrusError.badResponse("\(error)")
        }
    }

    /// Encode an `Encodable` (e.g. `FormSchema`, `Submission`) to JSON and upload it.
    @discardableResult
    public func uploadJson<T: Encodable>(
        _ object: T,
        owner: String,
        epochs: Int = 5,
        deletable: Bool = true
    ) async throws -> WalrusUploadResult {
        let data = try JSONEncoder().encode(object)
        return try await uploadBlob(
            data, owner: owner, epochs: epochs, deletable: deletable,
            filename: "payload.json", contentType: "application/json")
    }

    // MARK: - Multipart encoding

    private static func multipartBody(
        boundary: String,
        fields: [String: String],
        fileField: String,
        filename: String,
        contentType: String,
        fileData: Data
    ) -> Data {
        var body = Data()
        let crlf = "\r\n"
        func append(_ s: String) { body.append(s.data(using: .utf8)!) }

        for (name, value) in fields {
            append("--\(boundary)\(crlf)")
            append("Content-Disposition: form-data; name=\"\(name)\"\(crlf)\(crlf)")
            append("\(value)\(crlf)")
        }

        append("--\(boundary)\(crlf)")
        append(
            "Content-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(filename)\"\(crlf)")
        append("Content-Type: \(contentType)\(crlf)\(crlf)")
        body.append(fileData)
        append(crlf)
        append("--\(boundary)--\(crlf)")
        return body
    }
}

/// Module-level alias mirroring the JS `walrus` singleton (`walrus.readJson(...)`).
public let walrus = Walrus.shared
