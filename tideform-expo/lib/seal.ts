/**
 * lib/seal.ts — Seal encryption for PRIVATE fields (source-of-truth §7).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONESTY BOUNDARY (read this):
 *   `@mysten/seal` is browser/Node-oriented and needs WebCrypto `crypto.subtle`,
 *   which Hermes/JSC on React Native generally does NOT provide. So Seal here is
 *   BEST-EFFORT:
 *     • If real WebCrypto is present → genuine Seal encryption (mode:"seal").
 *     • Otherwise → a clearly-labeled NON-encrypting placeholder
 *       (mode:"placeholder") that base64-wraps the PLAINTEXT so the rest of the
 *       submission flow still works end-to-end in class.
 *   The placeholder is NEVER encryption. We never call the placeholder real
 *   encryption, and the envelope is tagged so the inbox/UI can warn.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Identity layout (form-bound, §7):
 *   identity bytes = <32-byte form objectID> || ":" || <fieldId> || ":" || <hex nonce>
 *   sealId (hex)   = hex(identity bytes)
 * Binds each ciphertext to one form AND restricts decryption to that form's
 * admins via tideform::acl::seal_approve(id, form).
 */

import { SealClient, SessionKey } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import {
  fromHex,
  normalizeSuiObjectId,
  toBase64,
  toHex,
} from '@mysten/sui/utils';
import * as Crypto from 'expo-crypto';

import { custodialSignMessage } from './api';
import { env } from './env';
import type { FieldValue } from './schema';
import { suiClient } from './sui';

// ── Capability detection ──────────────────────────────────────────────────────

/**
 * True only when a real WebCrypto SubtleCrypto is available. `react-native-get-
 * random-values` patches `getRandomValues` but NOT `subtle`, so on stock RN this
 * is usually false and we fall back to the placeholder.
 */
export function isSealAvailable(): boolean {
  const c = (globalThis as { crypto?: { subtle?: unknown } }).crypto;
  return !!(
    c &&
    c.subtle &&
    typeof (c.subtle as { encrypt?: unknown }).encrypt === 'function'
  );
}

let _client: SealClient | null = null;
function getSealClient(): SealClient {
  if (!_client) {
    // VERIFY: option name is `serverConfigs` on current @mysten/seal; older
    // builds used `serverObjectIds: string[]`. Adjust if your installed version
    // differs.
    _client = new SealClient({
      // @mysten/seal bundles its own copy of @mysten/sui, so the SuiClient type
      // is structurally-but-not-nominally identical. Cast across the version gap
      // (same workaround the Tideform web app uses).
      suiClient: suiClient as unknown as ConstructorParameters<typeof SealClient>[0]["suiClient"],
      serverConfigs: env.sealKeyServers.map((objectId) => ({
        objectId,
        weight: 1,
      })),
      verifyKeyServers: false,
    });
  }
  return _client;
}

// ── Identity ──────────────────────────────────────────────────────────────────

export interface SealIdentity {
  /** Raw identity bytes passed to acl::seal_approve and used as Seal `id`. */
  idBytes: Uint8Array;
  /** Hex of idBytes — stored in the FieldValue envelope as `id`. */
  sealIdHex: string;
  /** The hex nonce component (for reference). */
  nonceHex: string;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Build the form-bound Seal identity:
 *   <32-byte form objectID> || ":" || <fieldId> || ":" || <hex nonce>
 */
export function buildSealIdentity(
  formId: string,
  fieldId: string,
  nonceHex?: string,
): SealIdentity {
  // normalizeSuiObjectId → 0x + 64 hex; strip 0x for fromHex → 32 bytes.
  const formIdBytes = fromHex(normalizeSuiObjectId(formId).replace(/^0x/, ''));
  const nonce = nonceHex ?? toHex(Crypto.getRandomBytes(16));
  const colon = new Uint8Array([0x3a]); // ':'
  const idBytes = concatBytes(
    formIdBytes,
    colon,
    new TextEncoder().encode(fieldId),
    colon,
    new TextEncoder().encode(nonce),
  );
  return { idBytes, sealIdHex: toHex(idBytes), nonceHex: nonce };
}

/** Recover identity bytes from a stored envelope `id` (hex). */
export function decodeSealId(sealIdHex: string): Uint8Array {
  return fromHex(sealIdHex.replace(/^0x/, ''));
}

// ── Encrypt (submit path) ─────────────────────────────────────────────────────

export interface SealEncryptArgs {
  formId: string;
  fieldId: string;
  /** Plaintext bytes to protect. */
  data: Uint8Array;
  /** Optional fixed nonce (hex); a random 16-byte nonce is generated otherwise. */
  nonceHex?: string;
}

/**
 * NON-encrypting fallback. base64-wraps the PLAINTEXT and tags it
 * `mode:"placeholder"`. This is NOT encryption — it only keeps the teaching flow
 * runnable where WebCrypto is missing.
 */
function placeholderEnvelope(data: Uint8Array, sealIdHex?: string): FieldValue {
  return {
    kind: 'encrypted',
    envelope: { mode: 'placeholder', b64: toBase64(data), id: sealIdHex },
  };
}

/**
 * Encrypt one private field's bytes. Returns a `FieldValue` ready to drop into a
 * Submission. Falls back to the labeled placeholder when Seal can't run.
 */
export async function sealEncryptField(args: SealEncryptArgs): Promise<FieldValue> {
  const identity = buildSealIdentity(args.formId, args.fieldId, args.nonceHex);

  if (!isSealAvailable()) {
    return placeholderEnvelope(args.data, identity.sealIdHex);
  }

  try {
    const client = getSealClient();
    const { encryptedObject } = await client.encrypt({
      threshold: env.sealThreshold,
      packageId: env.packageId,
      id: identity.sealIdHex,
      data: args.data,
    });
    return {
      kind: 'encrypted',
      envelope: {
        mode: 'seal',
        b64: toBase64(encryptedObject),
        id: identity.sealIdHex,
      },
    };
  } catch {
    // Best-effort: never throw out of the submit flow — degrade to placeholder.
    return placeholderEnvelope(args.data, identity.sealIdHex);
  }
}

/** Convenience: encrypt a UTF-8 string value. */
export async function sealEncryptText(args: {
  formId: string;
  fieldId: string;
  text: string;
  nonceHex?: string;
}): Promise<FieldValue> {
  return sealEncryptField({
    formId: args.formId,
    fieldId: args.fieldId,
    data: new TextEncoder().encode(args.text),
    nonceHex: args.nonceHex,
  });
}

// ── Decrypt (admin inbox path) — best-effort, documented ──────────────────────

/**
 * Create a Seal SessionKey signed by the CUSTODIAL key via
 * /api/wallet/sign-message (replaces the wallet-popup signPersonalMessage).
 *
 * VERIFY: SessionKey API across @mysten/seal versions —
 *   `SessionKey.create({ address, packageId, ttlMin, suiClient })`,
 *   `getPersonalMessage()` / `setPersonalMessageSignature(sig)`.
 */
export async function createCustodialSessionKey(
  address: string,
  ttlMin = 10,
): Promise<SessionKey> {
  const sessionKey = await SessionKey.create({
    address,
    packageId: env.packageId,
    ttlMin,
    // Cast across the @mysten/seal-bundled @mysten/sui version gap (see getSealClient).
    suiClient: suiClient as unknown as Parameters<typeof SessionKey.create>[0]["suiClient"],
  });
  const personalMessage = sessionKey.getPersonalMessage();
  const { signature } = await custodialSignMessage(personalMessage);
  await sessionKey.setPersonalMessageSignature(signature);
  return sessionKey;
}

export interface SealDecryptArgs {
  formId: string;
  /** Full identity bytes (e.g. decodeSealId(envelope.id)). */
  idBytes: Uint8Array;
  /** Seal ciphertext bytes. */
  ciphertext: Uint8Array;
  sessionKey: SessionKey;
}

/**
 * Decrypt a Seal ciphertext for a form admin. Builds the form-bound approval PTB
 * (`acl::seal_approve(id, form)`), serializes only its kind bytes, and asks the
 * key servers (via the SessionKey proof) to release shares.
 *
 * Throws when Seal can't run on this runtime — callers should guard with
 * `isSealAvailable()` and surface the documented limitation.
 */
export async function sealDecrypt(args: SealDecryptArgs): Promise<Uint8Array> {
  if (!isSealAvailable()) {
    throw new Error(
      'Seal decryption unavailable: no WebCrypto subtle on this runtime. ' +
        'Private-field decryption is a documented best-effort capability on mobile.',
    );
  }
  const client = getSealClient();

  const tx = new Transaction();
  tx.moveCall({
    target: `${env.packageId}::acl::seal_approve`,
    arguments: [tx.pure.vector('u8', args.idBytes), tx.object(args.formId)],
  });
  const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });

  return client.decrypt({
    data: args.ciphertext,
    sessionKey: args.sessionKey,
    txBytes,
  });
}
