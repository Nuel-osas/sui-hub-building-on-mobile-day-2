//
//  SuiClient.swift
//  Tideform · Lib layer
//
//  Thin Sui JSON-RPC client over URLSession (no SDK needed for reads), mirroring the
//  Expo `lib/suiClient.ts` surface. Reads work straight from the device against the
//  public fullnode — no backend, no auth (source-of-truth §12).
//
//  Exposes the three RPC reads the app needs:
//    queryEvents / queryAllEvents, multiGetObjects, getObject.
//
//  Tx *building* (which needs BCS) lives in Move.swift via SuiKit; tx *signing* is
//  backend-delegated to Zentos (ZentosClient.swift). This file does neither.
//

import Foundation

public enum SuiRPCError: Error, CustomStringConvertible {
    case http(status: Int, body: String)
    case rpc(code: Int, message: String)
    case emptyResult
    case decoding(String)

    public var description: String {
        switch self {
        case .http(let s, let b): return "Sui RPC HTTP \(s): \(b)"
        case .rpc(let c, let m): return "Sui RPC error \(c): \(m)"
        case .emptyResult: return "Sui RPC returned an empty result"
        case .decoding(let m): return "Sui RPC decode failure: \(m)"
        }
    }
}

/// Module-level alias matching the shared lib contract (§10) and the
/// `indexer` / `walrus` / `zentos` singleton naming pattern.
public var suiClient: SuiClient { SuiClient.shared }

public final class SuiClient: @unchecked Sendable {

    /// Shared fullnode client for `env.network`.
    public static let shared = SuiClient(rpcURL: env.rpcURL)

    public let rpcURL: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(rpcURL: URL, session: URLSession = tideformURLSession) {
        self.rpcURL = rpcURL
        self.session = session
    }

    // MARK: - Core JSON-RPC

    private struct RPCRequest: Encodable {
        let jsonrpc = "2.0"
        let id = 1
        let method: String
        let params: [JSONValue]
    }

    private struct RPCResponse<T: Decodable>: Decodable {
        let result: T?
        let error: RPCError?
    }

    private struct RPCError: Decodable {
        let code: Int
        let message: String
    }

    /// Generic JSON-RPC call. `params` is an ordered array of JSON values.
    public func rpc<T: Decodable>(_ method: String, _ params: [JSONValue]) async throws -> T {
        var req = URLRequest(url: rpcURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try encoder.encode(RPCRequest(method: method, params: params))

        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw SuiRPCError.http(
                status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
        let decoded: RPCResponse<T>
        do {
            decoded = try decoder.decode(RPCResponse<T>.self, from: data)
        } catch {
            throw SuiRPCError.decoding("\(error)")
        }
        if let err = decoded.error { throw SuiRPCError.rpc(code: err.code, message: err.message) }
        guard let result = decoded.result else { throw SuiRPCError.emptyResult }
        return result
    }

    // MARK: - suix_queryEvents

    /// One page of events for a Move event type, newest-first by default.
    /// `eventType` is the fully-qualified `${ORIGINAL_PKG}::events::<Name>` (note: origin pkg).
    public func queryEvents(
        eventType: String,
        cursor: EventID? = nil,
        limit: Int = 50,
        descending: Bool = true
    ) async throws -> EventPage {
        let filter: JSONValue = .object(["MoveEventType": .string(eventType)])
        let cursorValue: JSONValue =
            cursor.map {
                .object(["txDigest": .string($0.txDigest), "eventSeq": .string($0.eventSeq)])
            } ?? .null
        let params: [JSONValue] = [
            filter, cursorValue, .number(Double(limit)), .bool(descending),
        ]
        return try await rpc("suix_queryEvents", params)
    }

    /// Pages through every event of a type (bounded by `maxPages` for safety).
    public func queryAllEvents(
        eventType: String,
        pageLimit: Int = 50,
        maxPages: Int = 50
    ) async throws -> [SuiEvent] {
        var all: [SuiEvent] = []
        var cursor: EventID? = nil
        for _ in 0..<maxPages {
            let page = try await queryEvents(eventType: eventType, cursor: cursor, limit: pageLimit)
            all.append(contentsOf: page.data)
            guard page.hasNextPage, let next = page.nextCursor else { break }
            cursor = next
        }
        return all
    }

    // MARK: - sui_getObject / sui_multiGetObjects

    public static let defaultObjectOptions: JSONValue = .object([
        "showContent": .bool(true),
        "showType": .bool(true),
        "showOwner": .bool(true),
    ])

    public func getObject(
        id: String, options: JSONValue = SuiClient.defaultObjectOptions
    ) async throws -> SuiObjectResponse {
        try await rpc("sui_getObject", [.string(id), options])
    }

    public func multiGetObjects(
        ids: [String], options: JSONValue = SuiClient.defaultObjectOptions
    ) async throws -> [SuiObjectResponse] {
        guard !ids.isEmpty else { return [] }
        let idArray: JSONValue = .array(ids.map { .string($0) })
        return try await rpc("sui_multiGetObjects", [idArray, options])
    }
}

// MARK: - Response models (public — consumed by Indexer.swift)

public struct EventID: Codable, Sendable, Hashable {
    public let txDigest: String
    public let eventSeq: String
}

public struct EventPage: Decodable, Sendable {
    public let data: [SuiEvent]
    public let nextCursor: EventID?
    public let hasNextPage: Bool

    private enum CodingKeys: String, CodingKey { case data, nextCursor, hasNextPage }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.data = (try? c.decode([SuiEvent].self, forKey: .data)) ?? []
        self.nextCursor = try? c.decode(EventID.self, forKey: .nextCursor)
        self.hasNextPage = (try? c.decode(Bool.self, forKey: .hasNextPage)) ?? false
    }
}

public struct SuiEvent: Decodable, Sendable {
    public let id: EventID
    public let packageId: String?
    public let transactionModule: String?
    public let sender: String?
    public let type: String
    /// Decoded Move event fields (e.g. `parsedJson["owner"]`, `parsedJson["form_id"]`).
    public let parsedJson: JSONValue?
    public let bcs: String?
    public let timestampMs: String?
}

public struct SuiObjectResponse: Decodable, Sendable {
    public let data: SuiObjectData?
    public let error: JSONValue?
}

public struct SuiObjectData: Decodable, Sendable {
    public let objectId: String
    public let version: String?
    public let digest: String?
    public let type: String?
    public let owner: JSONValue?
    public let content: SuiParsedData?
}

public struct SuiParsedData: Decodable, Sendable {
    public let dataType: String?
    public let type: String?
    /// The Move struct's fields (e.g. `fields["schema_blob_id"]`, `fields["admins"]`).
    public let fields: JSONValue?
    public let hasPublicTransfer: Bool?
}
