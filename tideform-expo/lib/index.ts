/**
 * lib/index.ts — the shared mobile lib CONTRACT, re-exported as one surface.
 *
 * The UI stage imports everything from here. The Swift `Lib/` exposes the same
 * named members so the class can diff the two stacks side by side.
 *
 *   import { env, suiClient, indexer, walrus, txSubmit, zentos, useAuth } from '@/lib';
 */

// Config + clients
export { env } from './env';
export type { Env, SuiNetwork } from './env';
export { suiClient } from './sui';

// Schema / types
export type {
  FieldType,
  FieldOption,
  FieldValidation,
  FieldConditional,
  Field,
  FormTheme,
  FormSettings,
  FormSection,
  FormSchema,
  FieldValue,
  Submission,
} from './schema';

// Reads / indexer (grouped + individual)
export * as indexer from './indexer';
export {
  listFormsForOwner,
  fetchForm,
  fetchFormSchema,
  listSubmissions,
  fetchSubmissionPayload,
  decodeAsciiBlobId,
} from './indexer';
export type { FormObject, SubmissionObject } from './indexer';

// Walrus (grouped + individual)
export * as walrus from './walrus';
export { readBlob, readJson, uploadBlob, uploadJson, blobUrl } from './walrus';
export type { UploadOptions, UploadResult } from './walrus';

// Move tx builders
export {
  txCreateForm,
  txUpdateFormSchema,
  txSetFormStatus,
  txSubmit,
  txSubmissionStatus,
  txSubmissionPriority,
  txAddTag,
  txAttachNotes,
} from './move';
export type {
  CreateFormArgs,
  UpdateFormSchemaArgs,
  SetFormStatusArgs,
  SubmitArgs,
  SubmissionStatusArgs,
  SubmissionPriorityArgs,
  AddTagArgs,
  AttachNotesArgs,
} from './move';

// Zentos client (custodial auth + sign — the "with a dev build" alternative)
export {
  ZentosClient,
  zentos,
  signInWithGoogle,
  getMe,
  signOut,
  signAndExecuteCustodial,
  custodialSignMessage,
} from './api';
export type {
  AuthUser,
  SignResult,
  SignMessageResult,
} from './api';

// Local device wallet (the Expo-Go path: non-custodial key + sponsored gas)
export {
  getOrCreateKeypair,
  loadKeypair,
  getStoredAddress,
  resetWallet,
  exportSecretKey,
} from './wallet';
export { signAndExecuteLocal } from './local-signer';
export type { LocalSignResult } from './local-signer';

// Auth hook / store
export {
  useAuth,
  getAuthState,
  restoreSession,
  signOutCurrent,
} from './auth';
export type { AuthStatus, AuthState, UseAuth } from './auth';

// Seal (best-effort encrypt for private fields)
export {
  isSealAvailable,
  buildSealIdentity,
  decodeSealId,
  sealEncryptField,
  sealEncryptText,
  createCustodialSessionKey,
  sealDecrypt,
} from './seal';
export type { SealIdentity, SealEncryptArgs, SealDecryptArgs } from './seal';

// Cookie session helpers (mostly internal; exported for tests/debugging)
export {
  cookieFetch,
  getCookieHeader,
  clearCookie,
  captureSetCookie,
} from './cookies';
