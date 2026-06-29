# Reads on-device — events, objects, Walrus blobs (no backend)

Querying Sui events, reading objects, and fetching Walrus blobs all hit **public
endpoints** and work straight from the phone — **no login, no backend, both auth models**.
Don't gate reads behind auth.

## Three invariants (get these wrong and nothing reads)

1. **Event type queries use `originalPackageId`**: the event type-origin
   (`${originalPackageId}::events::FormCreated`) never changes across package upgrades.
2. **`moveCall` targets use `packageId`** (the published-at). (That's writes — see
   `zentos-backend.md`.)
3. **Blob IDs are stored on-chain as ASCII `vector<u8>`** — i.e. a `number[]` of the
   ASCII codepoints of a base64url string. **Decode with `TextDecoder` (UTF-8). NEVER
   base64-decode them.** (Worked example at the bottom.)

## Walrus reads — public aggregator, no auth

```ts
// lib/walrus.ts  (read half — uploads are in zentos-backend.md)
import { env } from "./env";

export function blobUrl(id: string): string {
  return `${env.walrusAggregator}/v1/blobs/${id}`;
}

export async function readBlob(id: string): Promise<Uint8Array> {
  const r = await fetch(blobUrl(id));
  if (!r.ok) throw new Error(`walrus read ${id}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function readJson<T = unknown>(id: string): Promise<T> {
  const bytes = await readBlob(id);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
```

## The indexer — forms + submissions from events and objects

```ts
// lib/indexer.ts
import { suiClient } from "./suiClient";
import { env } from "./env";
import { readJson } from "./walrus";
import type { FormSchema, Submission } from "./types";

const td = new TextDecoder();

/** Blob IDs on-chain are ASCII vector<u8> (number[]). Decode UTF-8, never base64. */
function decodeBlobId(raw: number[] | string | undefined): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw; // some RPC shapes already give a string
  return td.decode(Uint8Array.from(raw));
}

export interface FormView {
  id: string;
  owner: string;
  admins: string[];
  schemaBlobId: string;
  version: number;
  status: number;          // 0 OPEN · 1 CLOSED · 2 ARCHIVED
  submissionsCount: number;
  requireWallet: boolean;
  onePerWallet: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SubmissionView {
  id: string;
  formId: string;
  blobId: string;
  submitter: string;
  submittedAtMs: number;
  status: number;          // 0 NEW · 1 IN_PROGRESS · 2 RESOLVED · 3 SPAM
  priority: number;        // 0 LOW · 1 MED · 2 HIGH · 3 URGENT
  tags: string[];
  hasNotes: boolean;
  notesBlobId: string;
}

/** Page through every event of a type, newest first (queryEvents caps each page). */
async function queryAllEvents(eventType: string, max = 200) {
  const out: any[] = [];
  let cursor: any = null;
  do {
    const page = await suiClient.queryEvents({
      query: { MoveEventType: eventType },
      order: "descending",
      cursor,
      limit: 50,
    });
    out.push(...page.data);
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor && out.length < max);
  return out;
}

function parseForm(id: string, fields: any): FormView {
  return {
    id,
    owner: fields.owner,
    admins: fields.admins?.fields?.contents ?? [], // VecSet → fields.contents (array of addresses)
    schemaBlobId: decodeBlobId(fields.schema_blob_id),
    version: Number(fields.version),
    status: Number(fields.status),
    submissionsCount: Number(fields.submissions_count),
    requireWallet: Boolean(fields.require_wallet),
    onePerWallet: Boolean(fields.one_per_wallet),
    createdAtMs: Number(fields.created_at_ms),
    updatedAtMs: Number(fields.updated_at_ms),
  };
}

function parseSubmission(id: string, fields: any): SubmissionView {
  return {
    id,
    formId: fields.form_id,
    blobId: decodeBlobId(fields.blob_id),
    submitter: fields.submitter,
    submittedAtMs: Number(fields.submitted_at_ms),
    status: Number(fields.status),
    priority: Number(fields.priority),
    tags: fields.tags ?? [],
    hasNotes: Boolean(fields.has_notes),
    notesBlobId: decodeBlobId(fields.notes_blob_id),
  };
}

/** B. My forms — FormCreated filtered by owner → multiGetObjects. */
export async function listFormsForOwner(owner: string): Promise<FormView[]> {
  const events = await queryAllEvents(`${env.originalPackageId}::events::FormCreated`);
  const ids = events
    .filter((e) => e.parsedJson?.owner === owner)
    .map((e) => e.parsedJson.form_id as string);
  return multiGetForms(ids);
}

async function multiGetForms(ids: string[]): Promise<FormView[]> {
  if (ids.length === 0) return [];
  const objs = await suiClient.multiGetObjects({ ids, options: { showContent: true } });
  const out: FormView[] = [];
  for (const o of objs) {
    const content = o.data?.content;
    if (content?.dataType === "moveObject") {
      out.push(parseForm(o.data!.objectId, (content as any).fields));
    }
  }
  return out;
}

/** C. Read one Form object back. */
export async function fetchForm(id: string): Promise<FormView | null> {
  const obj = await suiClient.getObject({ id, options: { showContent: true } });
  const content = obj.data?.content;
  if (content?.dataType !== "moveObject") return null;
  return parseForm(id, (content as any).fields);
}

/** Fetch + parse the form's schema JSON from Walrus. */
export async function fetchFormSchema(blobId: string): Promise<FormSchema> {
  return readJson<FormSchema>(blobId);
}

/** E. Admin inbox — SubmissionReceived filtered by form_id → multiGetObjects. */
export async function listSubmissions(formId: string): Promise<SubmissionView[]> {
  const events = await queryAllEvents(`${env.originalPackageId}::events::SubmissionReceived`);
  const ids = events
    .filter((e) => e.parsedJson?.form_id === formId)
    .map((e) => e.parsedJson.submission_id as string);
  if (ids.length === 0) return [];
  const objs = await suiClient.multiGetObjects({ ids, options: { showContent: true } });
  const out: SubmissionView[] = [];
  for (const o of objs) {
    const content = o.data?.content;
    if (content?.dataType === "moveObject") {
      out.push(parseSubmission(o.data!.objectId, (content as any).fields));
    }
  }
  return out;
}

/** Fetch + parse a submission payload JSON from Walrus. */
export async function fetchSubmissionPayload(blobId: string): Promise<Submission> {
  return readJson<Submission>(blobId);
}
```

## Event field reference (from the events module)

| Event (`${originalPackageId}::events::<Name>`) | Fields you read in `parsedJson` |
|---|---|
| `FormCreated` | `form_id: ID`, `owner: address`, `schema_blob_id: vector<u8>` |
| `SubmissionReceived` | `form_id: ID`, `submission_id: ID`, `blob_id: vector<u8>`, `submitter: address`, `submitted_at_ms: u64` |

Also emitted (for live-refresh / activity feeds): `FormUpdated`, `FormStatusChanged`,
`AdminAdded`, `AdminRemoved`, `SubmissionStatusChanged`, `SubmissionPriorityChanged`,
`SubmissionTagged`, `NotesAttached`.

## Object field reference

**Form** content fields: `owner`, `admins.fields.contents` (array of addresses),
`schema_blob_id` (`number[]` → `decodeBlobId`), `version`, `status`, `submissions_count`,
`require_wallet`, `one_per_wallet`, `created_at_ms`, `updated_at_ms`.

**Submission** content fields: `form_id`, `blob_id` (`number[]` → string), `submitter`,
`submitted_at_ms`, `status`, `priority`, `tags`, `has_notes`, `notes_blob_id`.

## Worked example — why blob IDs are UTF-8, not base64

A Walrus blob ID is a base64url string, e.g. `"q3F...x9A"`. On-chain it is stored as the
**ASCII bytes of that string**, so the RPC returns a `number[]` of those codepoints:

```ts
// on-chain schema_blob_id (truncated): [113, 51, 70, 46, 46, 46, 120, 57, 65]
const raw = [113, 51, 70];               // 'q','3','F'
new TextDecoder().decode(Uint8Array.from(raw)); // → "q3F"  ✅ this IS the blob id

// WRONG — never do this; it corrupts the id:
// Buffer.from(raw).toString("base64")   ❌
// atob(String.fromCharCode(...raw))     ❌
```

Then read it: `await readBlob("q3F...x9A")` → `GET {aggregator}/v1/blobs/q3F...x9A`.
