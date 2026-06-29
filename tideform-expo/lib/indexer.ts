/**
 * lib/indexer.ts — read-side queries. NO backend required (source-of-truth §12):
 * events, objects, and Walrus blobs are all read straight from the device against
 * public endpoints.
 *
 * Contract surface:
 *   listFormsForOwner(addr), fetchForm(id), fetchFormSchema(blobId),
 *   listSubmissions(formId), fetchSubmissionPayload(blobId)
 *
 * KEY DETAILS:
 *   - Event TYPE queries use the ORIGINAL package ID (env.originalPackageId) —
 *     event type-origin never changes across upgrades.
 *   - On-chain `vector<u8>` blob-ID fields are ASCII bytes of the blob-ID string.
 *     Decode with UTF-8 (decodeAsciiBlobId). NEVER base64-decode them.
 */

import type { SuiEvent, SuiObjectResponse } from '@mysten/sui/client';

import { env } from './env';
import type { FormSchema, Submission } from './schema';
import { suiClient } from './sui';
import { readJson } from './walrus';

const FORM_CREATED = `${env.originalPackageId}::events::FormCreated`;
const SUBMISSION_RECEIVED = `${env.originalPackageId}::events::SubmissionReceived`;

const MULTIGET_CHUNK = 50; // Sui multiGetObjects cap per call.
const MAX_EVENT_PAGES = 50; // safety bound for the teaching app.

// ── Parsed on-chain object shapes ─────────────────────────────────────────────

export interface FormObject {
  id: string;
  owner: string;
  admins: string[];
  /** Decoded Walrus blob ID of the form schema JSON. */
  schemaBlobId: string;
  createdAtMs: number;
  updatedAtMs: number;
  version: number;
  /** 0 OPEN · 1 CLOSED · 2 ARCHIVED */
  status: number;
  submissionsCount: number;
  requireWallet: boolean;
  onePerWallet: boolean;
}

export interface SubmissionObject {
  id: string;
  formId: string;
  /** Decoded Walrus blob ID of the submission payload JSON. */
  blobId: string;
  submitter: string;
  submittedAtMs: number;
  /** 0 NEW · 1 IN_PROGRESS · 2 RESOLVED · 3 SPAM */
  status: number;
  /** 0 LOW · 1 MED · 2 HIGH · 3 URGENT */
  priority: number;
  tags: string[];
  hasNotes: boolean;
  /** Decoded Walrus blob ID of admin notes, or "" if none. */
  notesBlobId: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Decode an on-chain ASCII `vector<u8>` blob-ID field to its string form.
 * Accepts the JSON-RPC number[] representation, a Uint8Array, or a string that
 * is already decoded (passed through unchanged). NEVER base64-decode.
 */
export function decodeAsciiBlobId(
  raw: number[] | Uint8Array | string | null | undefined,
): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw; // already the ASCII string
  const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
  return new TextDecoder().decode(bytes);
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return 0;
}

/** Pull the `fields` bag out of a moveObject response, or null. */
function moveFields(res: SuiObjectResponse): Record<string, any> | null {
  const content = res.data?.content;
  if (!content || content.dataType !== 'moveObject') return null;
  return (content as { fields: Record<string, any> }).fields ?? null;
}

function objectId(res: SuiObjectResponse): string {
  return res.data?.objectId ?? '';
}

function parseFormObject(res: SuiObjectResponse): FormObject | null {
  const f = moveFields(res);
  if (!f) return null;
  // VecSet<address> serializes as { fields: { contents: [...] } }.
  const admins: string[] = Array.isArray(f.admins?.fields?.contents)
    ? f.admins.fields.contents
    : Array.isArray(f.admins?.contents)
      ? f.admins.contents
      : [];
  return {
    id: objectId(res) || f.id?.id || '',
    owner: f.owner,
    admins,
    schemaBlobId: decodeAsciiBlobId(f.schema_blob_id),
    createdAtMs: num(f.created_at_ms),
    updatedAtMs: num(f.updated_at_ms),
    version: num(f.version),
    status: num(f.status),
    submissionsCount: num(f.submissions_count),
    requireWallet: Boolean(f.require_wallet),
    onePerWallet: Boolean(f.one_per_wallet),
  };
}

function parseSubmissionObject(res: SuiObjectResponse): SubmissionObject | null {
  const s = moveFields(res);
  if (!s) return null;
  return {
    id: objectId(res) || s.id?.id || '',
    formId: s.form_id,
    blobId: decodeAsciiBlobId(s.blob_id),
    submitter: s.submitter,
    submittedAtMs: num(s.submitted_at_ms),
    status: num(s.status),
    priority: num(s.priority),
    tags: Array.isArray(s.tags) ? s.tags : [],
    hasNotes: Boolean(s.has_notes),
    notesBlobId: decodeAsciiBlobId(s.notes_blob_id),
  };
}

/** Query ALL events of a type (paginated, descending), with a safety bound. */
async function queryAllEvents(moveEventType: string): Promise<SuiEvent[]> {
  const all: SuiEvent[] = [];
  let cursor: { txDigest: string; eventSeq: string } | null | undefined = null;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const res = await suiClient.queryEvents({
      query: { MoveEventType: moveEventType },
      cursor: cursor ?? null,
      limit: 50,
      order: 'descending',
    });
    all.push(...res.data);
    if (!res.hasNextPage || !res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return all;
}

async function multiGet(ids: string[]): Promise<SuiObjectResponse[]> {
  const out: SuiObjectResponse[] = [];
  for (let i = 0; i < ids.length; i += MULTIGET_CHUNK) {
    const chunk = ids.slice(i, i + MULTIGET_CHUNK);
    const res = await suiClient.multiGetObjects({
      ids: chunk,
      options: { showContent: true, showType: true },
    });
    out.push(...res);
  }
  return out;
}

// ── Contract surface ──────────────────────────────────────────────────────────

/**
 * Forms owned by `addr`: query FormCreated, keep those whose `owner` matches,
 * then multiGetObjects to read current Form state. (Flow B.)
 */
export async function listFormsForOwner(addr: string): Promise<FormObject[]> {
  const events = await queryAllEvents(FORM_CREATED);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const pj = ev.parsedJson as { form_id?: string; owner?: string } | undefined;
    if (!pj?.form_id || pj.owner !== addr) continue;
    if (seen.has(pj.form_id)) continue;
    seen.add(pj.form_id);
    ids.push(pj.form_id);
  }
  if (ids.length === 0) return [];
  const objects = await multiGet(ids);
  return objects
    .map(parseFormObject)
    .filter((f): f is FormObject => f !== null);
}

/** Read a single Form object's current on-chain state. */
export async function fetchForm(id: string): Promise<FormObject | null> {
  const res = await suiClient.getObject({
    id,
    options: { showContent: true, showType: true },
  });
  return parseFormObject(res);
}

/** Fetch + parse the form schema JSON from Walrus by its blob ID. */
export async function fetchFormSchema(blobId: string): Promise<FormSchema> {
  return readJson<FormSchema>(blobId);
}

/**
 * Submissions for a form: query SubmissionReceived filtered by `form_id`, then
 * multiGetObjects to read current Submission state (status/priority/tags). (Flow E.)
 */
export async function listSubmissions(formId: string): Promise<SubmissionObject[]> {
  const events = await queryAllEvents(SUBMISSION_RECEIVED);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const pj = ev.parsedJson as
      | { form_id?: string; submission_id?: string }
      | undefined;
    if (!pj?.submission_id || pj.form_id !== formId) continue;
    if (seen.has(pj.submission_id)) continue;
    seen.add(pj.submission_id);
    ids.push(pj.submission_id);
  }
  if (ids.length === 0) return [];
  const objects = await multiGet(ids);
  return objects
    .map(parseSubmissionObject)
    .filter((s): s is SubmissionObject => s !== null);
}

/** Fetch + parse a submission payload JSON from Walrus by its blob ID. */
export async function fetchSubmissionPayload(blobId: string): Promise<Submission> {
  return readJson<Submission>(blobId);
}
