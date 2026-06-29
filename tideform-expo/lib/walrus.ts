/**
 * lib/walrus.ts — Walrus blob I/O (source-of-truth §5).
 *
 *  READS  → public aggregator, no auth, straight from the device.
 *             GET ${WALRUS_AGGREGATOR}/v1/blobs/{blobId} → raw bytes
 *
 *  WRITES → SPONSORED via the Zentos backend (zero WAL/SUI for the user).
 *             POST multipart/form-data ${BACKEND}/api/walrus/upload
 *             fields: file, creator_address, epochs=5, deletable=true
 *             → { blob_id, sponsored_blob_id, tx_digest, end_epoch?, wal_cost? }
 *           The returned `blob_id` is what you store ON-CHAIN.
 *
 * This is the `walrus` member of the shared lib contract:
 *   readBlob, readJson, uploadBlob, uploadJson, blobUrl
 */

import { toBase64 } from '@mysten/sui/utils';
import * as FileSystem from 'expo-file-system';

import { cookieFetch } from './cookies';
import { env } from './env';

/** Public aggregator URL for a blob (use directly as an <Image> source, etc.). */
export function blobUrl(blobId: string): string {
  return `${env.walrusAggregator}/v1/blobs/${blobId}`;
}

/** Read a blob's raw bytes from the public aggregator. */
export async function readBlob(blobId: string): Promise<Uint8Array> {
  const res = await fetch(blobUrl(blobId));
  if (!res.ok) {
    throw new Error(`Walrus read failed for ${blobId}: ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/** Read a blob and parse it as JSON. */
export async function readJson<T = unknown>(blobId: string): Promise<T> {
  const res = await fetch(blobUrl(blobId));
  if (!res.ok) {
    throw new Error(`Walrus read failed for ${blobId}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface UploadOptions {
  /** Sui address recorded as the blob's creator (the signed-in user). */
  owner: string;
  /** Storage duration in Walrus epochs. Backend default mirrors the web app (5). */
  epochs?: number;
  /** Whether the blob is deletable. Defaults to true (matches the web app). */
  deletable?: boolean;
  /** MIME type for the multipart part (informational). */
  mime?: string;
  /** File name for the multipart part. */
  name?: string;
}

export interface UploadResult {
  /** The canonical Walrus blob ID — STORE THIS ON-CHAIN. */
  blobId: string;
  /** The sponsor-side blob ID (sponsored copy), if returned. */
  sponsoredBlobId?: string;
  /** Sponsor registration/certify tx digest. */
  txDigest?: string;
  endEpoch?: number;
  walCost?: number;
}

/** Backend JSON shape (snake_case) → normalized camelCase UploadResult. */
function normalizeUpload(json: Record<string, unknown>): UploadResult {
  return {
    blobId: String(json.blob_id ?? ''),
    sponsoredBlobId:
      json.sponsored_blob_id != null ? String(json.sponsored_blob_id) : undefined,
    txDigest: json.tx_digest != null ? String(json.tx_digest) : undefined,
    endEpoch: json.end_epoch != null ? Number(json.end_epoch) : undefined,
    walCost: json.wal_cost != null ? Number(json.wal_cost) : undefined,
  };
}

/**
 * Upload raw bytes via the sponsored backend route. The sponsor key lives only
 * on the server; the user pays nothing.
 *
 * RN gotcha (source-of-truth §12 / expo-sui skill): React Native's `FormData`
 * cannot reliably stream raw bytes or a `Blob` — the multipart body comes through
 * empty. The proven path is to stage the bytes to a cache file with
 * `expo-file-system`, then append a `{ uri, name, type }` file part. We write the
 * bytes as base64 (lossless for binary) and clean the temp file up afterwards.
 */
export async function uploadBlob(
  bytes: Uint8Array,
  opts: UploadOptions,
): Promise<UploadResult> {
  const name = opts.name ?? 'submission.json';
  const mime = opts.mime ?? 'application/octet-stream';

  // Stage the bytes to a cache file so RN can attach a real file part.
  const fileUri = `${FileSystem.cacheDirectory}tideform-upload-${Date.now()}`;
  await FileSystem.writeAsStringAsync(fileUri, toBase64(bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });

  try {
    const form = new FormData();
    // `as any` — RN's file-part shape isn't in the DOM FormData typings.
    form.append('file', { uri: fileUri, name, type: mime } as any);
    form.append('creator_address', opts.owner);
    form.append('epochs', String(opts.epochs ?? 5));
    form.append('deletable', String(opts.deletable ?? true));

    // Do NOT set Content-Type — the platform sets the multipart boundary itself.
    const res = await cookieFetch(`${env.backendBaseUrl}/api/walrus/upload`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Walrus upload failed: ${res.status} ${res.statusText} ${detail}`);
    }
    return normalizeUpload((await res.json()) as Record<string, unknown>);
  } finally {
    // Best-effort cleanup of the staged temp file.
    void FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
  }
}

/** Serialize an object to JSON bytes and upload it. */
export async function uploadJson(
  obj: unknown,
  opts: UploadOptions,
): Promise<UploadResult> {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return uploadBlob(bytes, {
    mime: 'application/json',
    name: 'payload.json',
    ...opts,
  });
}
