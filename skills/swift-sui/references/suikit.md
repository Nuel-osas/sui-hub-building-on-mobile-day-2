# SuiKit usage — client, JSON-RPC reads, building PTBs

[SuiKit](https://github.com/opendive/suikit) is the only real Swift Sui SDK. It is good
at: Ed25519/Secp256k1/Secp256r1 keypairs, address derivation, BCS, faucet, and a chunk of
JSON-RPC. It is **not** at parity with `@mysten/sui`, and its transaction-builder surface
moves between versions. **Rule:** trust SuiKit for keys/address/BCS; for JSON-RPC and
especially transaction building, write the call and tag uncertain bits
`// VERIFY: SuiKit API`, and keep a hand-rolled `URLSession` fallback that always works.

> Pin an exact SuiKit version/commit you have compiled. `main` can break.
> `// VERIFY: SuiKit version`.

---

## 1. The client (`suiClient`)

Two layers, used together:

- **`SuiRPC`** — a tiny hand-rolled `URLSession` JSON-RPC client. This is the dependable
  `suiClient`: it never breaks when SuiKit changes, and reads need no backend anyway.
- **SuiKit `SuiProvider`** — convenient typed wrappers; use where you've confirmed the
  method exists.

```swift
import Foundation

/// Dependable JSON-RPC client. This is `suiClient` in the Lib surface.
struct SuiRPC {
    static let shared = SuiRPC(url: Env.fullnodeURL)
    let url: URL

    struct RPCError: Error { let code: Int; let message: String }

    /// Generic call. `Result` is the decoded `result` field of the JSON-RPC envelope.
    func call<Result: Decodable>(_ method: String, _ params: [Any]) async throws -> Result {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
        ])
        let (data, _) = try await URLSession.shared.data(for: req)
        // Decode { result } or surface { error }
        let env = try JSONDecoder().decode(RPCEnvelope<Result>.self, from: data)
        if let e = env.error { throw RPCError(code: e.code, message: e.message) }
        guard let r = env.result else { throw RPCError(code: -1, message: "no result") }
        return r
    }
}

struct RPCEnvelope<R: Decodable>: Decodable {
    let result: R?
    let error: RPCErr?
    struct RPCErr: Decodable { let code: Int; let message: String }
}
```

SuiKit's own provider, for keys/address and where you've verified the read method:

```swift
import SuiKit

// Keypair + address — SuiKit is reliable here.
let account = try Account()                      // VERIFY: SuiKit API — Ed25519 by default
let address = try account.publicKey.toSuiAddress() // VERIFY: SuiKit API — address derivation
// NOTE: in the custodial model you do NOT generate keys on device — the backend holds them.
// You only need SuiKit keys for the Day-1 zkLogin path (references/quickstart.md).

// let provider = SuiProvider(connection: MainnetConnection())  // VERIFY: SuiKit API
```

---

## 2. JSON-RPC reads — the methods you actually call

These method names are **stable Sui JSON-RPC** (not SuiKit-specific), so the hand-rolled
`SuiRPC` is safe. Decode into `Decodable` structs whose shapes match the Move structs
(see `references/patterns.md` for the field-by-field mapping and the ASCII `vector<u8>`
decode rule).

### `suix_queryEvents` — find FormCreated / SubmissionReceived

```swift
// MoveEventType uses ORIGINAL package id (event type-origin never changes on upgrade).
struct EventPage<J: Decodable>: Decodable {
    let data: [EventEnvelope<J>]
    let hasNextPage: Bool
    let nextCursor: EventId?
}
struct EventEnvelope<J: Decodable>: Decodable { let parsedJson: J; let id: EventId }
struct EventId: Codable { let txDigest: String; let eventSeq: String }

struct FormCreatedJson: Decodable {
    let form_id: String
    let owner: String
    let schema_blob_id: [UInt8]   // ASCII vector<u8> -> UTF-8 decode, NOT base64
}

extension SuiRPC {
    func queryFormCreated(cursor: EventId? = nil) async throws -> EventPage<FormCreatedJson> {
        let filter: [String: Any] = [
            "MoveEventType": "\(Env.originalPackageId)::events::FormCreated"
        ]
        // params: [ filter, cursor, limit, descendingOrder ]
        return try await call("suix_queryEvents",
            [filter, cursor as Any, 50, true])
    }
}
```

### `sui_multiGetObjects` / `sui_getObject` — hydrate Form & Submission

```swift
struct ObjResp: Decodable { let data: ObjData? }
struct ObjData: Decodable { let objectId: String; let content: MoveContent? }
struct MoveContent: Decodable { let fields: FormFields? } // decode per type; see patterns.md

extension SuiRPC {
    func multiGetObjects(_ ids: [String]) async throws -> [ObjResp] {
        let options: [String: Any] = ["showContent": true, "showType": true]
        return try await call("sui_multiGetObjects", [ids, options])
    }
    func getObject(_ id: String) async throws -> ObjResp {
        let options: [String: Any] = ["showContent": true, "showType": true]
        return try await call("sui_getObject", [id, options])
    }
}
```

> Note `eventSeq`, `submitted_at_ms`, `version`, `submissions_count` etc. arrive as
> **strings** in JSON-RPC (u64 is serialized as a quoted decimal). Decode as `String` then
> convert, or use a `StringOrInt` helper (see `references/patterns.md`).

---

## 3. `Indexer` — the Lib reads surface

```swift
import Foundation

struct FormSummary: Identifiable {
    let id: String
    let owner: String
    let schemaBlobId: String
    var schema: FormSchema?
}

enum Indexer {
    /// Flow B: queryEvents(FormCreated) -> filter owner -> multiGetObjects.
    static func listFormsForOwner(_ addr: String) async throws -> [FormSummary] {
        var out: [FormSummary] = []
        var cursor: EventId? = nil
        repeat {
            let page = try await SuiRPC.shared.queryFormCreated(cursor: cursor)
            for ev in page.data where ev.parsedJson.owner == addr {
                out.append(FormSummary(
                    id: ev.parsedJson.form_id,
                    owner: ev.parsedJson.owner,
                    schemaBlobId: Blob.decode(ev.parsedJson.schema_blob_id) // UTF-8
                ))
            }
            cursor = page.hasNextPage ? page.nextCursor : nil
        } while cursor != nil
        return out
    }

    static func fetchForm(_ id: String) async throws -> Form {
        let resp = try await SuiRPC.shared.getObject(id)
        guard let fields = resp.data?.content?.fields else { throw IndexerError.notFound }
        return Form(objectId: id, fields: fields)   // see patterns.md for Form(fields:)
    }

    static func fetchFormSchema(_ blobId: String) async throws -> FormSchema {
        try await Walrus.readJson(blobId, as: FormSchema.self)
    }

    static func listSubmissions(_ formId: String) async throws -> [SubmissionObject] {
        // queryEvents(SubmissionReceived) filtered by form_id, then multiGetObjects.
        let ids = try await SuiRPC.shared.querySubmissionIds(formId: formId) // see patterns.md
        let objs = try await SuiRPC.shared.multiGetObjects(ids)
        return objs.compactMap { $0.data.flatMap { SubmissionObject(objectId: $0.objectId, content: $0.content) } }
    }

    /// Returns the §8 Submission JSON payload (not the on-chain object).
    static func fetchSubmissionPayload(_ blobId: String) async throws -> Submission {
        try await Walrus.readJson(blobId, as: Submission.self)
    }
}

enum IndexerError: Error { case notFound }

/// ASCII vector<u8> <-> String. Blob IDs are stored as UTF-8 bytes, NOT base64.
enum Blob {
    static func decode(_ bytes: [UInt8]) -> String { String(decoding: bytes, as: UTF8.self) }
    static func encode(_ s: String) -> [UInt8] { Array(s.utf8) }
}
```

(`Form`, `SubmissionObject`, `FormFields`, `querySubmissionIds` are defined in
`references/patterns.md`, where the Move-struct decoding lives.)

---

## 4. `Move` — building PTBs / transaction-kind bytes

The exact targets and argument orders come from source-of-truth §3/§4. The encoding rule
that bites people: **blob IDs are `pure.vector<u8>` of the ASCII string**, via
`Array(blobId.utf8)` — **not** base64-decoded.

The **uncertain** part is SuiKit's builder API: the constructor, `moveCall`, `pure`/`object`
argument helpers, and `build(onlyTransactionKind:)`. Each is tagged. The Move target
strings and argument **order** are exact and SDK-independent.

```swift
import SuiKit

enum Move {
    // form::create(vector<u8> schema_blob_id, bool require_wallet, bool one_per_wallet, &Clock)
    static func txCreateForm(schemaBlobId: String,
                             requireWallet: Bool,
                             onePerWallet: Bool) throws -> TransactionBlock {
        var tx = try TransactionBlock()                              // VERIFY: SuiKit API
        try tx.moveCall(                                            // VERIFY: SuiKit API
            target: "\(Env.packageId)::form::create",
            arguments: [
                tx.pure(value: .vector(.u8, Array(schemaBlobId.utf8))), // VERIFY: SuiKit API — vector<u8> pure
                tx.pure(value: .bool(requireWallet)),                  // VERIFY: SuiKit API
                tx.pure(value: .bool(onePerWallet)),                   // VERIFY: SuiKit API
                tx.object(id: Env.clockObjectId),                      // VERIFY: SuiKit API — Clock 0x6
            ]
        )
        return tx
    }

    // submission::submit(&mut Form, vector<u8> blob_id, &Clock)
    static func txSubmit(formId: String, blobId: String) throws -> TransactionBlock {
        var tx = try TransactionBlock()                              // VERIFY: SuiKit API
        try tx.moveCall(
            target: "\(Env.packageId)::submission::submit",
            arguments: [
                tx.object(id: formId),
                tx.pure(value: .vector(.u8, Array(blobId.utf8))),      // ASCII vector<u8>
                tx.object(id: Env.clockObjectId),
            ]
        )
        return tx
    }

    // form::set_status(&mut Form, u8 status)
    static func txSetFormStatus(formId: String, status: UInt8) throws -> TransactionBlock {
        var tx = try TransactionBlock()
        try tx.moveCall(target: "\(Env.packageId)::form::set_status",
            arguments: [tx.object(id: formId), tx.pure(value: .u8(status))]) // VERIFY: SuiKit API
        return tx
    }

    // submission::set_status(&Form, &mut Submission, u8 status)
    static func txSubmissionStatus(formId: String, submissionId: String, status: UInt8) throws -> TransactionBlock {
        var tx = try TransactionBlock()
        try tx.moveCall(target: "\(Env.packageId)::submission::set_status",
            arguments: [tx.object(id: formId), tx.object(id: submissionId), tx.pure(value: .u8(status))])
        return tx
    }

    // submission::set_priority(&Form, &mut Submission, u8 priority)
    static func txSubmissionPriority(formId: String, submissionId: String, priority: UInt8) throws -> TransactionBlock {
        var tx = try TransactionBlock()
        try tx.moveCall(target: "\(Env.packageId)::submission::set_priority",
            arguments: [tx.object(id: formId), tx.object(id: submissionId), tx.pure(value: .u8(priority))])
        return tx
    }

    // submission::attach_notes(&Form, &mut Submission, vector<u8> notes_blob_id)
    static func txAttachNotes(formId: String, submissionId: String, notesBlobId: String) throws -> TransactionBlock {
        var tx = try TransactionBlock()
        try tx.moveCall(target: "\(Env.packageId)::submission::attach_notes",
            arguments: [tx.object(id: formId), tx.object(id: submissionId),
                        tx.pure(value: .vector(.u8, Array(notesBlobId.utf8)))])
        return tx
    }

    // submission::add_tag(&Form, &mut Submission, String tag)
    static func txAddTag(formId: String, submissionId: String, tag: String) throws -> TransactionBlock {
        var tx = try TransactionBlock()
        try tx.moveCall(target: "\(Env.packageId)::submission::add_tag",
            arguments: [tx.object(id: formId), tx.object(id: submissionId),
                        tx.pure(value: .string(tag))])                 // VERIFY: SuiKit API — Move String (0x1::string)
        return tx
    }
}
```

### Building `txKindBytes`

`signAndExecuteCustodial` (in `references/zentos-backend.md`) calls
`tx.build(onlyTransactionKind: true)`. This is the single riskiest SuiKit call.

```swift
let kindBytes = try await tx.build(onlyTransactionKind: true)  // VERIFY: SuiKit API
let b64 = Data(kindBytes).base64EncodedString()
// POST { "txKindBytes": b64 } to /api/wallet/sign
```

**If your pinned SuiKit lacks an `onlyTransactionKind` flag** (it may only expose a full
`build` that needs gas + sender), do one of:
1. Check for an equivalent — e.g. a `TransactionKind`/`ProgrammableTransaction` serializer
   that emits BCS without gas data. `// VERIFY: SuiKit API — onlyTransactionKind equivalent`.
2. Hand-serialize the `TransactionKind::ProgrammableTransaction` with SuiKit's BCS
   primitives (SuiKit's BCS layer is reliable even when the high-level builder is not).
   `// VERIFY: SuiKit API — BCS TransactionKind layout`.
3. Use the `ZentosClient.signAndExecuteCustodial(txKindBytes:address:)` overload and feed
   it bytes from whichever of the above works. The HTTP side is exact regardless.

Do **not** invent a method name to paper over this — leave the `// VERIFY` and the
fallback so the next person knows it is the real boundary.

---

## 5. What SuiKit is and isn't good for (honest summary)

| Need | SuiKit? |
|---|---|
| Ed25519 keypair, address derivation | ✅ reliable (`// VERIFY` exact symbol) |
| BCS encode/decode primitives | ✅ reliable |
| JSON-RPC reads | ⚠️ works, but I prefer hand-rolled `SuiRPC` for stability |
| `moveCall` PTB building | ⚠️ API drifts — tag every call `// VERIFY: SuiKit API` |
| `build(onlyTransactionKind:)` | 🚩 riskiest — verify or hand-serialize BCS |
| zkLogin (nonce, proof, address) | 🚩 partial/none — see `references/quickstart.md` |
| Seal encrypt/decrypt | ❌ does not exist — backend-delegated / out of scope |
| Sponsored signing | ❌ not needed on device — the Zentos backend does it |
