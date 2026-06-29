# Zentos backend — endpoint contracts + the mobile TS client (Day-2)

Zentos = "Custodial Google → Sui wallet for apps." The web app uses it; **mobile reuses
the exact same HTTP endpoints**. You do NOT rebuild auth/signing/gas — you build a thin
native client over these routes. `backendBaseUrl` defaults to `https://tidalform.xyz` and
is env-overridable to a self-hosted Zentos instance or localhost.

## §6 endpoint contracts (verbatim from the source of truth)

### Auth

| Route | Body | Returns |
|---|---|---|
| `POST /api/auth/google` | `{ idToken }` (Google ID-token JWT) | `{ address, email, name, picture, isNew }` + **sets HMAC session cookie** |
| `GET  /api/auth/me` | — (cookie) | `{ address, email, name, picture, isExported }` or `401` |
| `POST /api/auth/logout` | — | clears cookie |

First sign-in mints an `Ed25519Keypair`, AES-256-GCM encrypts the secret, stores it in
Postgres keyed by the Google `sub`. **Same Google account → same Sui address forever.**

### Signing (custodial + sponsored)

| Route | Body | Returns |
|---|---|---|
| `POST /api/wallet/sign` | `{ txKindBytes }` (base64 of `tx.build({ onlyTransactionKind: true })`) | `{ digest, sponsorAddress, senderAddress }` |
| `POST /api/wallet/sign-message` | `{ message }` (base64 bytes) | `{ signature, address }` |
| `POST /api/wallet/export` | — | Bech32 `suiprivkey1…` (self-custody escape hatch) |

`/api/wallet/sign` decrypts the user's key in-memory, sets the **sponsor** wallet as gas
owner, signs as **both** sender (user) and sponsor, and executes. **User pays 0 SUI, sees
0 popups.** A Move-target allowlist prevents the sponsor from being drained by arbitrary
PTBs — only Tideform/Zentos package targets are honored.

`/api/wallet/sign-message` signs a personal message with the custodial key — this is what
Seal's `SessionKey` flow needs (proof-of-ownership before key servers release shares). On
mobile it replaces the wallet-popup `signPersonalMessage`.

### Walrus upload (sponsored)

| Route | Body (multipart/form-data) | Returns |
|---|---|---|
| `POST /api/walrus/upload` | `file=<bytes>`, `creator_address=0x..`, `epochs=5`, `deletable=true` | `{ blob_id, sponsored_blob_id, tx_digest, end_epoch?, wal_cost? }` |

The backend forwards to the Krilly sponsor with a server-only `Authorization: Bearer`
key that never reaches the device. **`blob_id` is what you store on-chain.**

---

## The Expo cookie-persistence trick (the #1 mobile gotcha)

The backend sets an **HttpOnly** session cookie. Expo's `fetch` does **not** persist
cookies across calls like a browser. So:

1. After `POST /api/auth/google`, read the `Set-Cookie` response header.
2. Keep only the `name=value` pair (everything before the first `;`).
3. Store it in **`expo-secure-store`**.
4. Re-attach it as a `Cookie` request header on every privileged call.

```ts
// lib/session.ts
import * as SecureStore from "expo-secure-store";

const COOKIE_KEY = "zentos.cookie";
let cached: string | null = null;

/** Persist the session cookie from a Set-Cookie header (or a raw "name=value"). */
export async function setSessionCookie(setCookieHeader: string | null) {
  if (!setCookieHeader) return;
  // Take just the first cookie pair; drop Path/Expires/HttpOnly attributes.
  // NOTE: RN folds multiple Set-Cookie headers into one comma-joined string. Tideform
  // sets a single session cookie, so splitting on ";" is safe here. If your backend sets
  // several cookies, parse them individually instead of naive comma-splitting (Expires
  // dates contain commas). // VERIFY if you add more cookies.
  const pair = setCookieHeader.split(";")[0].trim();
  if (!pair) return;
  cached = pair;
  await SecureStore.setItemAsync(COOKIE_KEY, pair);
}

export async function getSessionCookie(): Promise<string | null> {
  if (cached) return cached;
  cached = await SecureStore.getItemAsync(COOKIE_KEY);
  return cached;
}

export async function clearSession() {
  cached = null;
  await SecureStore.deleteItemAsync(COOKIE_KEY);
}
```

```ts
// lib/http.ts
import { env } from "./env";
import { getSessionCookie, setSessionCookie } from "./session";

/** fetch against backendBaseUrl that attaches the stored cookie and captures rotations. */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = await getSessionCookie();
  if (cookie) headers.set("Cookie", cookie);

  const res = await fetch(`${env.backendBaseUrl}${path}`, { ...init, headers });

  // If the server rotates / refreshes the session, persist the new value.
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) await setSessionCookie(setCookie);

  return res;
}
```

> Do NOT set `Content-Type` manually for the multipart upload — let `fetch` set the
> boundary. Do set it (`application/json`) for the JSON routes.

---

## The auth client

```ts
// lib/zentos.ts  (auth half)
import { authedFetch } from "./http";
import { clearSession } from "./session";

export interface AuthResult {
  address: string; email: string; name: string; picture: string; isNew: boolean;
}
export interface Me {
  address: string; email: string; name: string; picture: string; isExported: boolean;
}

/** Exchange a Google ID token for a custodial Sui address + a session cookie. */
export async function signInWithGoogle(idToken: string): Promise<AuthResult> {
  const res = await authedFetch("/api/auth/google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error(`auth/google ${res.status}: ${await res.text()}`);
  // authedFetch already captured the Set-Cookie for us.
  return res.json();
}

/** Restore the session on launch. Returns null if the cookie is missing/expired. */
export async function getMe(): Promise<Me | null> {
  const res = await authedFetch("/api/auth/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`auth/me ${res.status}`);
  return res.json();
}

export async function signOut(): Promise<void> {
  try {
    await authedFetch("/api/auth/logout", { method: "POST" });
  } finally {
    await clearSession();
  }
}
```

Wire it to the Google sign-in from `SKILL.md`:

```ts
const idToken = /* expo-auth-session id_token */;
const { address, name, picture } = await signInWithGoogle(idToken);
```

---

## The signing client (custodial + sponsored)

```ts
// lib/zentos.ts  (sign half)
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { suiClient } from "./suiClient";
import { authedFetch } from "./http";

export interface SignResult { digest: string; sponsorAddress: string; senderAddress: string }

/**
 * Build only the transaction KIND (no gas/sender signing on device), POST it to the
 * sponsor, which signs as both sender and sponsor and executes. User pays 0 SUI.
 * Mirrors web/src/lib/signer.ts.
 */
export async function signAndExecuteCustodial(
  tx: Transaction,
  custodialAddress: string,
): Promise<SignResult> {
  tx.setSender(custodialAddress);
  const txKindBytes = toBase64(
    await tx.build({ client: suiClient, onlyTransactionKind: true }),
  );
  const res = await authedFetch("/api/wallet/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txKindBytes }),
  });
  if (!res.ok) throw new Error(`wallet/sign ${res.status}: ${await res.text()}`);
  return res.json(); // { digest, sponsorAddress, senderAddress }
}

/**
 * Sign a personal message with the custodial key (Seal SessionKey proof-of-ownership).
 * The lib surface names this `custodialSignMessage`; it takes the message bytes the Seal
 * SessionKey hands you. Returns { signature (base64), address }.
 */
export async function custodialSignMessage(
  message: Uint8Array,
): Promise<{ signature: string; address: string }> {
  const res = await authedFetch("/api/wallet/sign-message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: toBase64(message) }),
  });
  if (!res.ok) throw new Error(`wallet/sign-message ${res.status}`);
  return res.json();
}
```

---

## Move tx builders (PTBs you route through the sponsor)

`packageId` = the published-at (moveCall target). **Blob IDs are encoded as `vector<u8>`
of the ASCII string** via `new TextEncoder().encode(blobId)` — NOT base64-decoded.

```ts
// lib/move.ts
import { Transaction } from "@mysten/sui/transactions";
import { env, CLOCK_ID } from "./env";

const enc = (s: string) => new TextEncoder().encode(s); // ASCII bytes of the blob-id string

// form::create(vector<u8> schema_blob_id, bool require_wallet, bool one_per_wallet, &Clock)
export function txCreateForm(schemaBlobId: string, requireWallet: boolean, onePerWallet: boolean) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${env.packageId}::form::create`,
    arguments: [
      tx.pure.vector("u8", enc(schemaBlobId)),
      tx.pure.bool(requireWallet),
      tx.pure.bool(onePerWallet),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

// submission::submit(&mut Form, vector<u8> blob_id, &Clock)
export function txSubmit(formId: string, blobId: string) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${env.packageId}::submission::submit`,
    arguments: [tx.object(formId), tx.pure.vector("u8", enc(blobId)), tx.object(CLOCK_ID)],
  });
  return tx;
}

// form::set_status(&mut Form, u8 status)   status: 0 OPEN · 1 CLOSED · 2 ARCHIVED
export function txSetFormStatus(formId: string, status: number) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${env.packageId}::form::set_status`,
    arguments: [tx.object(formId), tx.pure.u8(status)],
  });
  return tx;
}

// submission::set_status(&Form, &mut Submission, u8)  0 NEW · 1 IN_PROGRESS · 2 RESOLVED · 3 SPAM
export function txSubmissionStatus(formId: string, submissionId: string, status: number) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${env.packageId}::submission::set_status`,
    arguments: [tx.object(formId), tx.object(submissionId), tx.pure.u8(status)],
  });
  return tx;
}

// submission::set_priority(&Form, &mut Submission, u8)  0 LOW · 1 MED · 2 HIGH · 3 URGENT
export function txSubmissionPriority(formId: string, submissionId: string, priority: number) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${env.packageId}::submission::set_priority`,
    arguments: [tx.object(formId), tx.object(submissionId), tx.pure.u8(priority)],
  });
  return tx;
}

// submission::attach_notes(&Form, &mut Submission, vector<u8> notes_blob_id)
export function txAttachNotes(formId: string, submissionId: string, notesBlobId: string) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${env.packageId}::submission::attach_notes`,
    arguments: [tx.object(formId), tx.object(submissionId), tx.pure.vector("u8", enc(notesBlobId))],
  });
  return tx;
}

// submission::add_tag(&Form, &mut Submission, String tag)
export function txAddTag(formId: string, submissionId: string, tag: string) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${env.packageId}::submission::add_tag`,
    arguments: [tx.object(formId), tx.object(submissionId), tx.pure.string(tag)],
  });
  return tx;
}
```

---

## Sponsored Walrus uploads (RN multipart)

In React Native you can't append raw bytes to `FormData` — append a **file URI**.
Stage the bytes to the cache with `expo-file-system`, then upload.

```ts
// lib/walrus.ts  (upload half — reads are in reads.md)
import * as FileSystem from "expo-file-system";
import { toBase64 } from "@mysten/sui/utils";
import { authedFetch } from "./http";

export interface UploadResult {
  blob_id: string; sponsored_blob_id?: string; tx_digest?: string;
  end_epoch?: number; wal_cost?: number;
}

export async function uploadBlob(
  bytes: Uint8Array,
  opts: { owner: string; epochs?: number; deletable?: boolean; mime?: string; name?: string },
): Promise<UploadResult> {
  const { owner, epochs = 5, deletable = true, mime = "application/octet-stream", name = "payload.bin" } = opts;

  // RN multipart needs a file URI, not a Blob — stage bytes to the cache dir.
  const fileUri = `${FileSystem.cacheDirectory}up-${Date.now()}`;
  await FileSystem.writeAsStringAsync(fileUri, toBase64(bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });

  const form = new FormData();
  // @ts-expect-error RN FormData file shape
  form.append("file", { uri: fileUri, name, type: mime });
  form.append("creator_address", owner);
  form.append("epochs", String(epochs));
  form.append("deletable", String(deletable));

  // Do NOT set Content-Type — fetch sets the multipart boundary itself.
  const res = await authedFetch("/api/walrus/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error(`walrus/upload ${res.status}: ${await res.text()}`);
  return res.json(); // { blob_id, ... } — blob_id is what you store on-chain
}

export async function uploadJson(obj: unknown, opts: { owner: string; epochs?: number; deletable?: boolean }) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return uploadBlob(bytes, { ...opts, mime: "application/json", name: "payload.json" });
}
```

---

## End-to-end: submit a form (the gasless demo)

```ts
import { uploadJson } from "./walrus";
import { txSubmit } from "./move";
import { signAndExecuteCustodial } from "./zentos";
import type { Submission } from "./types";

async function submitForm(formId: string, formVersion: number, address: string, fields: Submission["fields"]) {
  // 1. assemble the Submission JSON (encrypt private fields if in scope — see patterns.md)
  const payload: Submission = {
    formId, formVersion, submittedAt: new Date().toISOString(), submitter: address, fields,
  };

  // 2. sponsored upload → blob_id
  const { blob_id } = await uploadJson(payload, { owner: address });

  // 3. build the submit PTB and route it through the sponsor
  const tx = txSubmit(formId, blob_id);
  const { digest } = await signAndExecuteCustodial(tx, address);

  // 4. surface the RECEIPT — tx digest + walrus blob id. Zero gas, zero popups.
  return { digest, blobId: blob_id };
}
```
