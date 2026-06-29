//
//  Move.swift
//  Tideform · Lib layer
//
//  Programmable-transaction-block (PTB) builders for the `tideform` Move package,
//  mirroring the Expo `lib/move.ts` surface:
//    txCreateForm, txSubmit, txSetFormStatus, txSubmissionStatus,
//    txSubmissionPriority, txAttachNotes, txAddTag
//
//  Targets + argument order are taken VERBATIM from source-of-truth §3/§4.
//  Each builder returns an unsigned SuiKit `TransactionBlock`. We never sign here —
//  `buildTransactionKindBase64(_:)` serializes `onlyTransactionKind` bytes which are
//  base64'd and POSTed to Zentos `/api/wallet/sign` (sponsored, popup-less, gasless).
//
//  CRITICAL ENCODING (source-of-truth §4 / §12): Walrus blob IDs are stored on-chain
//  as `vector<u8>` of their *ASCII bytes* — i.e. `TextEncoder().encode(blobId)` in JS,
//  `Array(blobId.utf8)` here. NEVER base64-decode a blob ID before encoding it.
//
//  SuiKit notes: confirmed against OpenDive/SuiKit `main`. Signatures used:
//    TransactionBlock() throws
//    func object(id: String) throws -> TransactionObjectArgument
//    func pure(value: SuiJsonValue) throws -> TransactionBlockInput
//    func moveCall(target:arguments:[TransactionArgument]?:typeArguments:returnValueCount:) throws -> [TransactionArgument]
//    func setSenderIfNotSet(sender: String) throws
//    func build(_ provider: SuiProvider, _ onlyTransactionKind: Bool?) async throws -> Data
//    enum TransactionArgument { case gasCoin; case input(TransactionBlockInput); case result; case nestedResult }
//    enum SuiJsonValue { case boolean(Bool); case uint8Number(UInt8); case string(String); case array([SuiJsonValue]); ... }
//  Anything version-sensitive is flagged `// VERIFY: SuiKit API`.
//

import Foundation
import SuiKit

public enum MoveError: Error {
    case build(String)
}

public enum Move {

    // MARK: - Provider used only to serialize transaction-kind bytes
    //
    // `build(onlyTransactionKind: true)` still resolves object args (the shared Clock
    // `0x6`, the `&mut Form`, the `&mut Submission`) against the fullnode, so a real
    // RPC connection is required even though we never execute here.

    /// Minimal `ConnectionProtocol` wrapper around the configured fullnode.
    private struct TideformConnection: ConnectionProtocol {
        let fullNode: String
        var faucet: String? { nil }
        var graphql: String? { nil }
        var websocket: String? { nil }
    }

    // VERIFY: SuiKit API — `SuiProvider(connection:)` and `ConnectionProtocol` confirmed
    // on main; if your pinned SuiKit ships preset `MainnetConnection()` etc., you may
    // swap this for one of those.
    public static let provider = SuiProvider(
        connection: TideformConnection(fullNode: env.rpcURL.absoluteString))

    // MARK: - Encoding helpers

    /// `vector<u8>` of a string's ASCII/UTF-8 bytes — the on-chain blob-ID encoding.
    private static func pureAsciiVector(_ tx: TransactionBlock, _ string: String) throws
        -> TransactionBlockInput
    {
        let bytes = Array(string.utf8)
        // VERIFY: SuiKit API — a `.array` of `.uint8Number` BCS-encodes as `vector<u8>`.
        // (Equivalent to TS `tx.pure.vector("u8", bytes)`.)
        return try tx.pure(value: .array(bytes.map { SuiJsonValue.uint8Number($0) }))
    }

    private static func pureBool(_ tx: TransactionBlock, _ value: Bool) throws
        -> TransactionBlockInput
    {
        try tx.pure(value: .boolean(value))
    }

    private static func pureU8(_ tx: TransactionBlock, _ value: UInt8) throws
        -> TransactionBlockInput
    {
        try tx.pure(value: .uint8Number(value))
    }

    private static func pureString(_ tx: TransactionBlock, _ value: String) throws
        -> TransactionBlockInput
    {
        // Move `std::string::String` (UTF-8). Equivalent to TS `tx.pure.string(value)`.
        try tx.pure(value: .string(value))
    }

    // VERIFY: SuiKit API — `tx.object(id:)` returns `TransactionObjectArgument`, which on
    // current SuiKit is usable directly as a `TransactionArgument` in `moveCall.arguments`.
    // Pure inputs are wrapped with `.input(...)`. If your SuiKit version instead returns a
    // `TransactionBlockInput` from `object(id:)`, wrap the object args with `.input(...)` too.

    // MARK: - form::create  (source-of-truth §4)
    //   args: vector<u8> schema_blob_id, bool require_wallet, bool one_per_wallet, &Clock(0x6)
    //   shares the Form and emits FormCreated.

    public static func txCreateForm(
        schemaBlobId: String,
        requireWallet: Bool,
        onePerWallet: Bool
    ) throws -> TransactionBlock {
        let tx = try TransactionBlock()
        let args: [TransactionArgument] = [
            .input(try pureAsciiVector(tx, schemaBlobId)),
            .input(try pureBool(tx, requireWallet)),
            .input(try pureBool(tx, onePerWallet)),
            try tx.object(id: "0x6"),
        ]
        _ = try tx.moveCall(target: "\(env.packageId)::form::create", arguments: args)
        return tx
    }

    // MARK: - submission::submit  (source-of-truth §4)
    //   args: &mut Form, vector<u8> blob_id, &Clock
    //   bumps the form's count, emits SubmissionReceived, shares the Submission.

    public static func txSubmit(
        formId: String,
        blobId: String
    ) throws -> TransactionBlock {
        let tx = try TransactionBlock()
        let args: [TransactionArgument] = [
            try tx.object(id: formId),
            .input(try pureAsciiVector(tx, blobId)),
            try tx.object(id: "0x6"),
        ]
        _ = try tx.moveCall(target: "\(env.packageId)::submission::submit", arguments: args)
        return tx
    }

    // MARK: - form::set_status  (source-of-truth §3.1)
    //   args: &mut Form, u8 status   (0 OPEN · 1 CLOSED · 2 ARCHIVED)

    public static func txSetFormStatus(
        formId: String,
        status: UInt8
    ) throws -> TransactionBlock {
        let tx = try TransactionBlock()
        let args: [TransactionArgument] = [
            try tx.object(id: formId),
            .input(try pureU8(tx, status)),
        ]
        _ = try tx.moveCall(target: "\(env.packageId)::form::set_status", arguments: args)
        return tx
    }

    // MARK: - submission::set_status  (admin-only; source-of-truth §3.2/§4)
    //   args: &Form, &mut Submission, u8 status   (0 NEW · 1 IN_PROGRESS · 2 RESOLVED · 3 SPAM)

    public static func txSubmissionStatus(
        formId: String,
        submissionId: String,
        status: UInt8
    ) throws -> TransactionBlock {
        let tx = try TransactionBlock()
        let args: [TransactionArgument] = [
            try tx.object(id: formId),
            try tx.object(id: submissionId),
            .input(try pureU8(tx, status)),
        ]
        _ = try tx.moveCall(target: "\(env.packageId)::submission::set_status", arguments: args)
        return tx
    }

    // MARK: - submission::set_priority  (admin-only; source-of-truth §3.2)
    //   args: &Form, &mut Submission, u8 priority  (0 LOW · 1 MED · 2 HIGH · 3 URGENT)

    public static func txSubmissionPriority(
        formId: String,
        submissionId: String,
        priority: UInt8
    ) throws -> TransactionBlock {
        let tx = try TransactionBlock()
        let args: [TransactionArgument] = [
            try tx.object(id: formId),
            try tx.object(id: submissionId),
            .input(try pureU8(tx, priority)),
        ]
        _ = try tx.moveCall(target: "\(env.packageId)::submission::set_priority", arguments: args)
        return tx
    }

    // MARK: - submission::attach_notes  (admin-only; source-of-truth §3.2)
    //   args: &Form, &mut Submission, vector<u8> notes_blob_id

    public static func txAttachNotes(
        formId: String,
        submissionId: String,
        notesBlobId: String
    ) throws -> TransactionBlock {
        let tx = try TransactionBlock()
        let args: [TransactionArgument] = [
            try tx.object(id: formId),
            try tx.object(id: submissionId),
            .input(try pureAsciiVector(tx, notesBlobId)),
        ]
        _ = try tx.moveCall(target: "\(env.packageId)::submission::attach_notes", arguments: args)
        return tx
    }

    // MARK: - submission::add_tag  (admin-only; source-of-truth §3.2)
    //   args: &Form, &mut Submission, String tag

    public static func txAddTag(
        formId: String,
        submissionId: String,
        tag: String
    ) throws -> TransactionBlock {
        let tx = try TransactionBlock()
        let args: [TransactionArgument] = [
            try tx.object(id: formId),
            try tx.object(id: submissionId),
            .input(try pureString(tx, tag)),
        ]
        _ = try tx.moveCall(target: "\(env.packageId)::submission::add_tag", arguments: args)
        return tx
    }

    // MARK: - Serialization for the custodial signer

    /// Serialize `onlyTransactionKind` bytes and base64-encode them for `/api/wallet/sign`.
    /// This is the exact `txKindBytes` the Zentos backend co-signs (sender + sponsor).
    public static func buildTransactionKindBase64(
        _ tx: TransactionBlock,
        sender: String? = nil
    ) async throws -> String {
        if let sender { try tx.setSenderIfNotSet(sender: sender) }
        // VERIFY: SuiKit API — `build(_:_:)` second arg is `onlyTransactionKind` (Bool?).
        let data = try await tx.build(provider, true)
        return data.base64EncodedString()
    }
}
