/**
 * lib/schema.ts — Form schema + submission payload types.
 *
 * Mirrors the production web app's `web/src/lib/schema.ts` (source-of-truth §8).
 * Plain TypeScript types (no zod) so both the Expo and Swift teaching ports can
 * expose the SAME named surface: FieldType, Field, FormSchema, Submission,
 * FieldValue.
 *
 * Two distinct JSON documents are described here, both uploaded to Walrus:
 *   1. FormSchema   → blob ID is stored on-chain as Form.schema_blob_id.
 *   2. Submission   → blob ID is the `blob_id` arg to submission::submit.
 */

// ── Field types (14, exactly as in the web app) ───────────────────────────────
export type FieldType =
  | 'short_text'
  | 'long_text'
  | 'rich_text'
  | 'dropdown'
  | 'multi_select'
  | 'checkbox'
  | 'rating'
  | 'screenshot'
  | 'video'
  | 'url'
  | 'number'
  | 'date'
  | 'email'
  | 'wallet';

export interface FieldOption {
  label: string;
  value: string;
}

export interface FieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** rating fields: number of steps (e.g. 5 stars). */
  maxRating?: number;
  [key: string]: unknown;
}

/** Show/hide this field based on another field's value. */
export interface FieldConditional {
  fieldId: string;
  operator?: 'eq' | 'neq' | 'includes' | 'gt' | 'lt';
  value?: unknown;
}

export interface Field {
  id: string;
  type: FieldType;
  label: string;
  help?: string;
  placeholder?: string;
  required: boolean;
  /** When true the value is Seal-encrypted before upload (see lib/seal.ts). */
  private: boolean;
  defaultValue?: unknown;
  validation?: FieldValidation;
  /** dropdown / multi_select choices. */
  options?: FieldOption[];
  conditional?: FieldConditional;
}

export interface FormTheme {
  primary: string;
  mode: 'light' | 'dark' | 'system';
}

export interface FormSettings {
  requireWallet: boolean;
  onePerWallet: boolean;
  captcha?: boolean;
  successMessage?: string;
  style: 'compact' | 'conversational';
  redirectUrl?: string;
  [key: string]: unknown;
}

export interface FormSection {
  id: string;
  title?: string;
  fields: Field[];
}

export interface FormSchema {
  /** Schema-format version. */
  version: number;
  /** Author-facing form revision (bumped on edit; mirrors Form.version on-chain). */
  formVersion: number;
  title: string;
  description: string;
  /** Optional Walrus blob ID of a banner image. */
  bannerBlobId?: string;
  theme: FormTheme;
  settings: FormSettings;
  sections: FormSection[];
}

// ── Submission payload ────────────────────────────────────────────────────────

/**
 * One field's submitted value. Discriminated by `kind`:
 *  - plaintext        → value stored in the clear.
 *  - media            → file uploaded to Walrus; reference kept here.
 *  - encrypted        → small value Seal-encrypted inline (base64 ciphertext).
 *                       `mode:"placeholder"` means NOT really encrypted (see seal.ts).
 *  - encrypted-media  → file ciphertext uploaded to Walrus; Seal id kept here.
 */
export type FieldValue =
  | { kind: 'plaintext'; value: unknown }
  | { kind: 'media'; blobId: string; mime: string; bytes: number; name: string }
  | {
      kind: 'encrypted';
      envelope: { mode: 'seal' | 'placeholder'; b64: string; id?: string };
    }
  | {
      kind: 'encrypted-media';
      blobId: string;
      sealId: string;
      mime: string;
      bytes: number;
      name: string;
    };

export interface Submission {
  formId: string;
  formVersion: number;
  /** ISO-8601 timestamp. */
  submittedAt: string;
  /** Sui address of the submitter, when known (require_wallet / signed-in). */
  submitter?: string;
  fields: Record<string, FieldValue>;
}
