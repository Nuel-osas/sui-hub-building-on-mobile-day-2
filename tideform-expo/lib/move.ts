/**
 * lib/move.ts — Transaction (PTB) builders for the `tideform` Move package.
 *
 * Encodings copied EXACTLY from the production `web/src/lib/move.ts`
 * (source-of-truth §4). Two things students must internalize:
 *
 *   1. moveCall targets use the `published-at` package ID (env.packageId).
 *   2. Walrus blob IDs go on-chain as `vector<u8>` of the ASCII STRING bytes
 *      (`new TextEncoder().encode(blobId)`) — they are NOT base64-decoded.
 *
 * Every builder returns an unsigned `Transaction`. Hand it to
 * `signAndExecuteCustodial(tx, address)` (lib/api.ts) for gasless, popup-less
 * execution.
 */

import { Transaction } from '@mysten/sui/transactions';

import { env } from './env';

const PKG = env.packageId;
const CLOCK = '0x6'; // shared Clock object, always 0x6

/** ASCII bytes of a Walrus blob ID, for `tx.pure.vector("u8", …)`. */
function asciiBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ── form module ───────────────────────────────────────────────────────────────

export interface CreateFormArgs {
  schemaBlobId: string;
  requireWallet: boolean;
  onePerWallet: boolean;
}

/**
 * `form::create(vector<u8> schema_blob_id, bool require_wallet, bool one_per_wallet, &Clock)`
 * Shares the new Form object and emits FormCreated.
 */
export function txCreateForm(args: CreateFormArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::form::create`,
    arguments: [
      tx.pure.vector('u8', asciiBytes(args.schemaBlobId)),
      tx.pure.bool(args.requireWallet),
      tx.pure.bool(args.onePerWallet),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

export interface UpdateFormSchemaArgs {
  formId: string;
  schemaBlobId: string;
}

/** `form::update_schema(&mut Form, vector<u8> new_schema_blob_id, &Clock)` */
export function txUpdateFormSchema(args: UpdateFormSchemaArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::form::update_schema`,
    arguments: [
      tx.object(args.formId),
      tx.pure.vector('u8', asciiBytes(args.schemaBlobId)),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

export interface SetFormStatusArgs {
  formId: string;
  /** 0 OPEN · 1 CLOSED · 2 ARCHIVED */
  status: number;
}

/** `form::set_status(&mut Form, u8 status)` */
export function txSetFormStatus(args: SetFormStatusArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::form::set_status`,
    arguments: [tx.object(args.formId), tx.pure.u8(args.status)],
  });
  return tx;
}

// ── submission module ─────────────────────────────────────────────────────────

export interface SubmitArgs {
  formId: string;
  blobId: string;
}

/**
 * `submission::submit(&mut Form, vector<u8> blob_id, &Clock)`
 * Bumps the form's count, emits SubmissionReceived, shares the Submission.
 */
export function txSubmit(args: SubmitArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::submission::submit`,
    arguments: [
      tx.object(args.formId),
      tx.pure.vector('u8', asciiBytes(args.blobId)),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

export interface SubmissionStatusArgs {
  formId: string;
  submissionId: string;
  /** 0 NEW · 1 IN_PROGRESS · 2 RESOLVED · 3 SPAM */
  status: number;
}

/** `submission::set_status(&Form, &mut Submission, u8 status)` — admin only. */
export function txSubmissionStatus(args: SubmissionStatusArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::submission::set_status`,
    arguments: [
      tx.object(args.formId),
      tx.object(args.submissionId),
      tx.pure.u8(args.status),
    ],
  });
  return tx;
}

export interface SubmissionPriorityArgs {
  formId: string;
  submissionId: string;
  /** 0 LOW · 1 MED · 2 HIGH · 3 URGENT */
  priority: number;
}

/** `submission::set_priority(&Form, &mut Submission, u8 priority)` — admin only. */
export function txSubmissionPriority(args: SubmissionPriorityArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::submission::set_priority`,
    arguments: [
      tx.object(args.formId),
      tx.object(args.submissionId),
      tx.pure.u8(args.priority),
    ],
  });
  return tx;
}

export interface AddTagArgs {
  formId: string;
  submissionId: string;
  tag: string;
}

/** `submission::add_tag(&Form, &mut Submission, String tag)` — admin only. */
export function txAddTag(args: AddTagArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::submission::add_tag`,
    arguments: [
      tx.object(args.formId),
      tx.object(args.submissionId),
      tx.pure.string(args.tag),
    ],
  });
  return tx;
}

export interface AttachNotesArgs {
  formId: string;
  submissionId: string;
  /** Walrus blob ID of the notes payload (stored on-chain as ASCII vector<u8>). */
  notesBlobId: string;
}

/** `submission::attach_notes(&Form, &mut Submission, vector<u8> notes_blob_id)` — admin only. */
export function txAttachNotes(args: AttachNotesArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::submission::attach_notes`,
    arguments: [
      tx.object(args.formId),
      tx.object(args.submissionId),
      tx.pure.vector('u8', asciiBytes(args.notesBlobId)),
    ],
  });
  return tx;
}
