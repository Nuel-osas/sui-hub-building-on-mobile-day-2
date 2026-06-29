---
name: expo-sui
description: >-
  Build Sui mobile apps in Expo / React Native (iOS + Android). Use when the user
  says "build a Sui mobile app in Expo", "expo sui zklogin", "react native sui",
  "sui mobile app", "port my Sui dApp to mobile", "mobile wallet-less Sui login",
  "gasless mobile transactions on Sui", or wants Google sign-in + a Sui address +
  signing on a phone with no wallet extension. Encodes BOTH auth models taught in
  the mobile workshop: Day-1 zkLogin (non-custodial, on-device, prover round-trip)
  and Day-2 Zentos custodial backend (server-held key, sponsored + popup-less).
  Covers project scaffold, native Google sign-in via expo-auth-session, Expo
  session-cookie persistence, reading Sui events/objects + Walrus blobs on-device,
  building PTBs and routing them through a custodial sponsor, and sponsored Walrus
  uploads. Opinionated, copy-pasteable, targets the Tideform forms platform.
tools: Read, Glob, Grep, Bash, Write, Edit
---

# expo-sui — a kit for building Sui mobile apps in Expo

Mobile Sui dApps have **no wallet to connect to**. There is no Sui Wallet extension and
no Suiet on a phone — the entire desktop "Connect Wallet" pattern does not exist. This
skill replaces it with two production-grade patterns and tells you when to use each.

It is built against **Tideform** (a Walrus-native forms/feedback platform, live at
tidalform.xyz) and its auth/wallet backend **Zentos**. All on-chain IDs, endpoints,
Move targets, and type shapes are pinned in
`day2-repo/docs/00-architecture-source-of-truth.md` — that file is the ground truth.
**Never invent IDs, endpoint paths, Move function names, or SDK methods.** If something
is not given, mark it `// VERIFY: <what to confirm>` rather than fabricate.

## When to activate

Activate whenever the user wants to build, scaffold, or extend a **Sui app on Expo /
React Native** — login, reading on-chain data, submitting transactions, uploading to
Walrus, or porting an existing Sui web dApp to a phone. Also activate for "why won't my
mobile zkLogin / Google sign-in work" debugging (see `references/patterns.md`).

For native iOS Swift, this has a sibling kit (`swift-sui`) that exposes the **same named
lib surface** — keep the two in sync.

## The two auth models — pick one up front

| | **Day-1: zkLogin (on-device)** | **Day-2: Zentos custodial backend** |
|---|---|---|
| Key custody | User's ephemeral key + ZK proof; address derived from JWT+salt | Server holds an AES-encrypted Ed25519 key, keyed by Google `sub` |
| Trust model | Non-custodial; user controls signing | Custodial; backend signs on the user's behalf (exportable escape hatch) |
| Gas | User pays (unless you add a separate gas station) | **Sponsored — user pays 0 SUI, sees 0 popups** |
| What the phone does | Generates ephemeral key, fetches proof from a prover, signs locally | Thin client: POSTs an unsigned PTB to the backend, gets a digest back |
| Complexity on device | High (prover round-trip, salt mgmt, proof assembly, crypto polyfills) | Low (HTTP + a session cookie) |
| Use it when | You need true non-custodial UX, or you're teaching how zkLogin works | You want the simplest shippable consumer app with gasless UX |

**Default recommendation: Zentos custodial (Day-2)** for any app that wants the
headline "gasless + popup-less" experience with minimal on-device crypto. Reach for
**zkLogin (Day-1)** when non-custodial control is a hard requirement. The decentralized
fusion of the two (salt on Walrus behind a Move `seal_approve`, self-hosted GPU prover)
is an advanced module — out of scope for the v1 kit; point at
`zentos/docs/decentralized-zklogin.md`.

Both models share the **reads** layer (events, objects, Walrus blobs are public and
need no backend) — see `references/reads.md`.

## Project setup

```bash
# Scaffold (matches the workshop)
pnpm dlx create-expo-app@latest tideform-mobile --template tabs
cd tideform-mobile

# Sui SDK + Google sign-in + secure storage + crypto bits
pnpm add @mysten/sui expo-auth-session expo-secure-store expo-crypto \
         expo-web-browser expo-file-system jwt-decode
pnpm add react-native-get-random-values   # crypto.getRandomValues polyfill (REQUIRED)
```

`app.json` (or `app.config.ts`) must set a custom `scheme` — it is the OAuth redirect
target and the deep-link namespace:

```jsonc
{ "expo": { "scheme": "tideform", "ios": { "bundleIdentifier": "xyz.tideform.app" },
            "android": { "package": "xyz.tideform.app" } } }
```

Public config goes in `EXPO_PUBLIC_*` env vars (Expo inlines these at build time):

```bash
EXPO_PUBLIC_SUI_NETWORK=mainnet            # or testnet for the workshop
EXPO_PUBLIC_BACKEND_URL=https://tidalform.xyz
EXPO_PUBLIC_GOOGLE_CLIENT_ID=...           # VERIFY: your Google OAuth client id
EXPO_PUBLIC_TIDEFORM_PACKAGE_ID=0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4
EXPO_PUBLIC_TIDEFORM_ORIGINAL_ID=0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4
EXPO_PUBLIC_WALRUS_AGGREGATOR=https://aggregator.walrus-mainnet.walrus.space
```

## The shared `lib/` surface

Both the Expo `lib/` and the Swift `Lib/` expose the **same named functions** so the two
stacks can be diffed line-for-line. Lay the Expo project out like this:

```
lib/
  polyfills.ts   # import once at app entry (crypto.getRandomValues, TextEncoder)
  env.ts         # network, packageId, originalPackageId, walrusAggregator,
                 # backendBaseUrl, googleClientId, sealKeyServers, sealThreshold
  suiClient.ts   # fullnode client for `network`
  types.ts       # FieldType, Field, FormSchema, Submission, FieldValue
  session.ts     # expo-secure-store cookie persistence            (zentos-backend.md)
  http.ts        # authedFetch — attaches + rotates the cookie     (zentos-backend.md)
  walrus.ts      # readBlob/readJson/blobUrl + sponsored uploads   (reads.md / zentos-backend.md)
  indexer.ts     # listFormsForOwner, fetchForm, fetchFormSchema,
                 # listSubmissions, fetchSubmissionPayload          (reads.md)
  move.ts        # txCreateForm, txSubmit, txSetFormStatus, txSubmissionStatus,
                 # txSubmissionPriority, txAttachNotes, txAddTag     (zentos-backend.md)
  zentos.ts      # signInWithGoogle, getMe, signOut,
                 # signAndExecuteCustodial, custodialSignMessage     (zentos-backend.md)
```

### `lib/polyfills.ts` — import this FIRST, before any `@mysten/sui` code

```ts
// lib/polyfills.ts
import "react-native-get-random-values"; // makes crypto.getRandomValues exist (keypair + nonce gen)
// Hermes ships TextEncoder/TextDecoder on recent Expo SDKs. If you hit
// "TextEncoder is not defined", add: import "fast-text-encoding";
```

### `lib/env.ts` — all IDs come from env, nothing hard-coded into logic

```ts
// lib/env.ts
export type Network = "mainnet" | "testnet";

const NETWORK = (process.env.EXPO_PUBLIC_SUI_NETWORK ?? "mainnet") as Network;

export const env = {
  network: NETWORK,
  // published-at: used for moveCall targets
  packageId:
    process.env.EXPO_PUBLIC_TIDEFORM_PACKAGE_ID ??
    "0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4",
  // original-id: used for EVENT TYPE queries (never changes across upgrades)
  originalPackageId:
    process.env.EXPO_PUBLIC_TIDEFORM_ORIGINAL_ID ??
    "0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4",
  walrusAggregator:
    process.env.EXPO_PUBLIC_WALRUS_AGGREGATOR ??
    (NETWORK === "mainnet"
      ? "https://aggregator.walrus-mainnet.walrus.space"
      : "https://aggregator.walrus-testnet.walrus.space"),
  // Defaults to the live deployment so the app works out of the box.
  backendBaseUrl: process.env.EXPO_PUBLIC_BACKEND_URL ?? "https://tidalform.xyz",
  googleClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? "", // VERIFY: your OAuth client
  // Mainnet Seal key server (free, public, threshold 1)
  sealKeyServers: [
    "0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a",
  ],
  sealThreshold: 1,
} as const;

export const CLOCK_ID = "0x6"; // shared Clock object, always
```

### `lib/suiClient.ts`

```ts
// lib/suiClient.ts
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { env } from "./env";

export const suiClient = new SuiClient({ url: getFullnodeUrl(env.network) });
```

### `lib/types.ts` — schema + submission shapes (from `web/src/lib/schema.ts`)

```ts
// lib/types.ts
export type FieldType =
  | "short_text" | "long_text" | "rich_text" | "dropdown" | "multi_select"
  | "checkbox" | "rating" | "screenshot" | "video" | "url" | "number"
  | "date" | "email" | "wallet";

export interface FieldOption { id: string; label: string; value?: string }

export interface Field {
  id: string;
  type: FieldType;
  label: string;
  help?: string;
  placeholder?: string;
  required: boolean;
  private: boolean; // true → encrypt with Seal (see Seal caveats in patterns.md)
  defaultValue?: unknown;
  validation?: Record<string, unknown>;
  options?: FieldOption[];
  conditional?: unknown;
}

export interface FormSchema {
  version: number | string;
  formVersion: number | string;
  title: string;
  description?: string;
  bannerBlobId?: string;
  theme: { primary: string; mode: "light" | "dark" | string };
  settings: {
    requireWallet: boolean;
    onePerWallet: boolean;
    captcha?: boolean;
    successMessage?: string;
    style: "compact" | "conversational";
    redirectUrl?: string;
    [k: string]: unknown;
  };
  sections: { id: string; title?: string; fields: Field[] }[];
}

export type FieldValue =
  | { kind: "plaintext"; value: unknown }
  | { kind: "media"; blobId: string; mime: string; bytes: number; name: string }
  | { kind: "encrypted"; envelope: { mode: "seal" | "placeholder"; b64: string; id?: string } }
  | { kind: "encrypted-media"; blobId: string; sealId: string; mime: string; bytes: number; name: string };

export interface Submission {
  formId: string;
  formVersion: number | string;
  submittedAt: string; // ISO
  submitter?: string;
  fields: Record<string, FieldValue>;
}
```

## Native Google sign-in (both models start here)

Use `expo-auth-session` with **`responseType: id_token`** and scopes **`openid email`**.
Google returns an ID-token JWT — that JWT is what you feed into either model:

- **zkLogin (Day-1):** bind the JWT to an ephemeral key via a `nonce`, derive the
  address with `jwtToAddress(jwt, salt)`. Full screen in `references/quickstart.md`.
- **Zentos (Day-2):** POST `{ idToken }` to `/api/auth/google`; the backend mints/loads
  the custodial key and returns `{ address, email, name, picture, isNew }` + a session
  cookie. Client in `references/zentos-backend.md`.

```ts
import * as AuthSession from "expo-auth-session";

const discovery = { authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth" };
const redirectUri = AuthSession.makeRedirectUri({ scheme: "tideform" });

const request = new AuthSession.AuthRequest({
  clientId: env.googleClientId,
  redirectUri,
  responseType: AuthSession.ResponseType.IdToken,
  scopes: ["openid", "email"],
  // zkLogin only: extraParams: { nonce } — binds the JWT to the ephemeral key
});
const result = await request.promptAsync(discovery);
const idToken = result.type === "success"
  ? (result.params.id_token ?? result.authentication?.idToken)
  : null;
```

> The `redirectUri` printed by `makeRedirectUri` MUST be registered verbatim in the
> Google Cloud console for this OAuth client, or you get `redirect_uri_mismatch`. See
> `references/patterns.md`.

## Session-cookie handling in Expo (custodial model)

The backend sets an **HttpOnly session cookie**. Expo's `fetch` does **not** persist
cookies like a browser, so you capture `Set-Cookie` once and resend it as a `Cookie`
header on every privileged call. Persist it in **`expo-secure-store`**. The complete
`lib/session.ts` + `lib/http.ts` (`authedFetch`) is in `references/zentos-backend.md`.

## Reads on-device (no backend, both models)

Querying events, objects, and Walrus blobs works straight from the phone against public
endpoints. Full `lib/indexer.ts` + Walrus reads in `references/reads.md`. Three rules:

1. **Event type queries use `originalPackageId`** (`${originalPackageId}::events::FormCreated`),
   because the event type-origin never changes across package upgrades.
2. **`moveCall` targets use `packageId`** (the published-at).
3. **Blob IDs are stored on-chain as ASCII `vector<u8>`** — decode the `number[]` with
   `TextDecoder` (UTF-8). **Never base64-decode them.** They are already base64url
   strings; the bytes on-chain are the ASCII codepoints of that string.

## Writes: PTB → custodial sponsor (gasless, popup-less)

You build a normal `@mysten/sui` `Transaction`, then **do not sign on device** — you
serialize just the transaction kind and POST it to the backend, which sets the sponsor as
gas owner and signs as both sender and sponsor:

```ts
// from lib/zentos.ts
export async function signAndExecuteCustodial(tx, address) {
  tx.setSender(address);
  const txKindBytes = toBase64(await tx.build({ client: suiClient, onlyTransactionKind: true }));
  const res = await authedFetch("/api/wallet/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txKindBytes }),
  });
  return res.json(); // { digest, sponsorAddress, senderAddress }
}
```

Submit flow end-to-end: assemble the `Submission` JSON → `uploadJson` to Walrus
(sponsored) → get `blob_id` → `txSubmit(formId, blobId)` → `signAndExecuteCustodial`.
The backend enforces a **Move-target allowlist** (only Tideform/Zentos packages), so the
sponsor can't be drained by arbitrary PTBs.

## Sponsored Walrus uploads

Uploads are POSTed as `multipart/form-data` to the app's own `/api/walrus/upload`
(`file`, `creator_address`, `epochs=5`, `deletable=true`) → `{ blob_id, sponsored_blob_id,
tx_digest, ... }`. The backend forwards to the Krilly sponsor with a server-only API key
that never reaches the device. **`blob_id` is what you store on-chain.** In React Native
you cannot append raw bytes to `FormData` — stage them to a file URI first
(`expo-file-system`). Full `uploadBlob` / `uploadJson` in `references/zentos-backend.md`.

## The gasless / popup-less UX rules (the headline — preserve and surface it)

1. **Never show a gas prompt.** Sponsored signing means the user has 0 SUI and approves
   nothing. If your UI implies "confirm in wallet", delete it.
2. **No seed phrase, no wallet install, no QR handoff.** Sign-in is one Google tap.
3. **Show the receipt, not the signature.** After a write, surface the **tx digest** and
   the **Walrus blob ID** as the proof-of-success — that's the demo moment: "I submitted,
   there was no gas prompt, and there's no SUI in my wallet."
4. **Offer the escape hatch quietly.** `/api/wallet/export` returns a Bech32
   `suiprivkey1…` so custody is recoverable — surface it in settings, not the main flow.
5. **Reads are instant and offline-friendly.** They hit public endpoints; don't gate them
   behind login.

## Reference files

- `references/quickstart.md` — one-command scaffold + a minimal working **zkLogin** login
  screen (Day-1 path, on-device).
- `references/zentos-backend.md` — the §6 endpoint contracts + the full TS client
  (`signInWithGoogle`, `getMe`, `signOut`, `signAndExecuteCustodial`,
  `custodialSignMessage`) with the Expo cookie-persistence trick.
- `references/reads.md` — querying `FormCreated` / `SubmissionReceived`, `multiGetObjects`,
  decoding ASCII `vector<u8>` blob IDs, fetching Walrus blobs — all on-device.
- `references/patterns.md` — do/don't and the common errors (`redirect_uri_mismatch`,
  cookies not persisting, base64-vs-ASCII blob IDs, Seal-in-RN caveats).
