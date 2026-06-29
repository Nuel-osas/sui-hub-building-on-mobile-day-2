# Build Tideform Mobile, Screen by Screen (Expo)

A hands-on guide to building the **UI layer** of the Tideform Expo app on top of the
already-written `lib/`. By the end you'll have rebuilt all five flows (A–E from
source-of-truth §9) yourself.

This mirrors the **web app**: on the website, `web/src/lib/*` holds the client logic and
`web/src/app/**` holds the React pages. On mobile it's the same split — `lib/*` is given to you
(it's the direct port of the web `lib/`), and **you build the screens** in `app/*` with Expo
Router. The mental model to leave with: *a mobile dApp is mostly a re-skin of the same client
code, plus one hard idea — there is no wallet extension on a phone, so signing moves behind an
HTTP call.* (See [`../docs/01-web-to-mobile-map.md`](../docs/01-web-to-mobile-map.md).)

> **Golden rule:** import only the **real exports** from `@/lib`. Never invent an on-chain ID,
> endpoint path, Move target, or SDK method. If you need something the lib doesn't give you,
> derive it or mark `// VERIFY: <what to confirm>` — never fabricate.

**Prereqs:** finish [README.md](./README.md) (install, `.env`, Google client ID). Then run
`npm start` and keep Metro hot-reloading as you go. Typecheck anytime with `npm run lint`.

---

## 0. The lib surface you'll build against

Everything comes from one import site — `@/lib` (re-exported by `lib/index.ts`):

```ts
import {
  // config + types
  env,
  type Field, type FieldValue, type FormSchema, type Submission,
  type FormObject, type SubmissionObject,
  // auth (Flow A)
  useAuth,
  // reads (Flows B, C, E) — no backend, no cookie
  listFormsForOwner, fetchForm, fetchFormSchema,
  listSubmissions, fetchSubmissionPayload,
  // walrus
  blobUrl, uploadJson,
  // move PTB builders + custodial signing (Flow D)
  txSubmit, signAndExecuteCustodial,
  // seal (private fields, best-effort)
  isSealAvailable, sealEncryptText, createCustodialSessionKey, sealDecrypt, decodeSealId,
} from '@/lib';
```

Two shared components you'll also build:

```ts
import { FieldRenderer } from '@/components/field-renderer';
import { Receipt } from '@/components/receipt';
```

Routes Expo Router will derive from the file names (file-based routing):

| File | Route | Flow |
|---|---|---|
| `app/login.tsx` | `/login` | A |
| `app/index.tsx` | `/` | B |
| `app/f/[id].tsx` | `/f/:id` | C + D |
| `app/inbox/[id].tsx` | `/inbox/:id` | E |
| `app/_layout.tsx` | (root) | guard + restore |

`app.json` already declares `"scheme": "tideform"` and the `expo-router` plugin, and
`package.json` sets `"main": "expo-router/entry"` — so routing "just works" once the files exist.

---

## 1. Root layout + auth guard — `app/_layout.tsx`

**Web parallel:** the Next.js root layout + middleware that bounces signed-out users to
`/login`. On mobile, `_layout.tsx` is the single navigator and the single gate.

Responsibilities:

1. **Restore the session once on launch.** `useAuth().restore()` calls `getMe()` →
   `GET /api/auth/me` using the cookie persisted in `expo-secure-store`. There's no wallet to
   reconnect — the session *is* the cookie.
2. **Guard the route tree.** Signed-out users go to `/login`; a signed-in user on `/login` goes
   home.
3. **Mount the `Stack`** for the four screens.

```tsx
import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuth } from '@/lib';

function useAuthGuard(status: string, isAuthenticated: boolean) {
  const segments = useSegments();
  const router = useRouter();
  useEffect(() => {
    // Don't redirect until the session has actually resolved.
    if (status === 'idle' || status === 'restoring' || status === 'loading') return;
    const onLogin = segments[0] === 'login';
    if (!isAuthenticated && !onLogin) router.replace('/login');
    else if (isAuthenticated && onLogin) router.replace('/');
  }, [status, isAuthenticated, segments, router]);
}

export default function RootLayout() {
  const { status, isAuthenticated, restore } = useAuth();
  useEffect(() => { void restore(); }, []);     // exactly once on launch
  useAuthGuard(status, isAuthenticated);

  const booting = status === 'idle' || status === 'restoring';
  return (
    <SafeAreaProvider>
      {booting ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" />
        </View>
      ) : (
        <Stack>
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="index" options={{ title: 'My Forms' }} />
          <Stack.Screen name="f/[id]" options={{ title: 'Form' }} />
          <Stack.Screen name="inbox/[id]" options={{ title: 'Inbox' }} />
        </Stack>
      )}
    </SafeAreaProvider>
  );
}
```

**Why the guard returns early during `idle/restoring/loading`:** redirecting before the session
resolves causes a flash of `/login` for already-signed-in users. The `AuthStatus` union
(`idle → restoring → authenticated | unauthenticated`, plus `loading` during an active sign-in)
is your single source of truth — read it, don't duplicate it.

> Hot-reload check: launch the app. With no session you should land on `/login`. (The full file
> in this repo also themes the `Stack` headers — styling is yours to taste.)

---

## 2. Flow A — Sign in — `app/login.tsx`

**Web parallel:** the "Continue with Google" button that kicks off the Zentos OAuth flow. On
desktop a wallet extension might sign; on a phone there is none — Google sign-in *is* the
on-ramp.

All the logic already lives in the `useAuth` hook (`lib/auth.ts`). The screen is pure
presentation + one button:

```tsx
import { useAuth, env } from '@/lib';
import { Pressable, Text, View, ActivityIndicator } from 'react-native';

export default function LoginScreen() {
  const { signIn, ready, status, error } = useAuth();
  const busy = status === 'loading';
  const needsClientId = !env.googleClientId;

  return (
    <View style={{ flex: 1, justifyContent: 'space-between', padding: 24 }}>
      {/* brand + the gasless / popup-less / no-seed-phrase selling points */}
      {error ? <Text>{error}</Text> : null}
      {needsClientId ? <Text>Set EXPO_PUBLIC_GOOGLE_CLIENT_ID in .env (see README).</Text> : null}
      <Pressable disabled={!ready || busy} onPress={() => void signIn()}>
        {busy ? <ActivityIndicator /> : <Text>Continue with Google</Text>}
      </Pressable>
    </View>
  );
}
```

What happens under the hood when you tap the button (don't rebuild this — just understand it):

1. `signIn()` → `promptAsync()` opens the native Google sheet (`expo-auth-session` +
   `expo-web-browser`).
2. Google returns an **id_token** JWT. `useAuth` posts it to `signInWithGoogle(idToken)` →
   `POST /api/auth/google`.
3. The backend mints (first time) or loads (every time after) an `Ed25519Keypair`, AES-256-GCM
   encrypts it keyed by Google `sub`, and sets an **HMAC session cookie**. *Same Google account →
   same Sui address forever.*
4. `lib/cookies.ts` captures the `Set-Cookie` and stores it in `expo-secure-store` — because
   RN `fetch` does **not** persist cookies like a browser (source-of-truth §12). Every later
   privileged call replays it as a `Cookie` header.
5. The store flips to `authenticated`, the guard in `_layout.tsx` sends you home.

**Framing to surface on this screen:** gasless · popup-less · no seed phrase. That's the whole
Day-2 pitch and the login screen is where you sell it.

---

## 3. Flow B — My Forms — `app/index.tsx`

**Web parallel:** the dashboard list of forms you own. **All on-device reads — no backend, no
cookie** (source-of-truth §9.B, §12).

The lib does the heavy lifting in two calls:

- `listFormsForOwner(address)` — queries the `FormCreated` event by the **original** package
  type (`${env.originalPackageId}::events::FormCreated`; event type-origin is stable across
  upgrades), keeps events whose `owner === address`, then `multiGetObjects` to read current
  `Form` state into `FormObject[]`.
- `fetchFormSchema(blobId)` — reads + parses the schema JSON from the Walrus aggregator, so you
  can show each form's `title`.

```tsx
import { useEffect, useState, useCallback } from 'react';
import { FlatList, Pressable, Text, View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { listFormsForOwner, fetchFormSchema, useAuth, type FormObject } from '@/lib';

interface FormRow extends FormObject { title: string }

export default function MyFormsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const address = user?.address;
  const [rows, setRows] = useState<FormRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    const forms = await listFormsForOwner(address);
    const withTitles = await Promise.all(
      forms.map(async (f): Promise<FormRow> => {
        let title = '(untitled form)';
        try { const s = await fetchFormSchema(f.schemaBlobId); if (s?.title) title = s.title; }
        catch { /* a missing/old schema blob shouldn't hide the form */ }
        return { ...f, title };
      }),
    );
    withTitles.sort((a, b) => b.createdAtMs - a.createdAtMs); // newest first
    setRows(withTitles);
    setLoading(false);
  }, [address]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <ActivityIndicator size="large" />;
  return (
    <FlatList
      data={rows}
      keyExtractor={(f) => f.id}
      renderItem={({ item }) => (
        <Pressable onPress={() => router.push({ pathname: '/f/[id]', params: { id: item.id } })}>
          <Text>{item.title}</Text>
          <Text>{item.submissionsCount} submissions · v{item.version}</Text>
          <Pressable onPress={() => router.push({ pathname: '/inbox/[id]', params: { id: item.id } })}>
            <Text>Inbox ({item.submissionsCount}) →</Text>
          </Pressable>
        </Pressable>
      )}
    />
  );
}
```

Build steps:

1. Read `address` from `useAuth().user`.
2. `load()` → `listFormsForOwner(address)` → resolve each title with `fetchFormSchema`. Wrap the
   schema fetch in `try/catch` so one bad blob can't blank the list.
3. Render a `FlatList`. Tap a card → `router.push('/f/[id]')`. Add an **Inbox** button →
   `/inbox/[id]` since these are forms you own.
4. Add a `RefreshControl` (pull-to-refresh) and an empty/error state. The shipped screen also
   shows a `⚡ Submissions are sponsored — 0 SUI gas, 0 popups` banner and a sign-out button.

> **`FormObject` fields you'll use:** `id`, `title` (from schema), `status` (0 OPEN · 1 CLOSED ·
> 2 ARCHIVED), `submissionsCount`, `version`, `owner`, `admins[]`. These come straight off the
> parsed Move struct — see `lib/indexer.ts`.

---

## 4. Flows C + D — View, fill, and submit — `app/f/[id].tsx`

This is the heart of the app and the only screen that talks to the backend.

### 4a. Flow C — view + fill

**Web parallel:** the public form page that renders the schema and collects answers.

```tsx
import { useLocalSearchParams } from 'expo-router';
import { fetchForm, fetchFormSchema } from '@/lib';

const { id } = useLocalSearchParams<{ id: string }>();
const formId = String(id ?? '');

// load():
const f = await fetchForm(formId);                 // FormObject | null
if (!f) throw new Error('Form not found on-chain.');
const schema = await fetchFormSchema(f.schemaBlobId); // FormSchema
```

Flatten the sections into fields and seed a `values` map, then render each field with
`<FieldRenderer>` (built in §6):

```tsx
const fields = schema.sections.flatMap((s) => s.fields);

{schema.sections.map((section) => (
  <View key={section.id}>
    {section.title ? <Text>{section.title}</Text> : null}
    {section.fields.map((field) => (
      <FieldRenderer
        key={field.id}
        field={field}
        value={values[field.id]}
        onChange={(v) => setValue(field.id, v)}
        error={errors[field.id]}
      />
    ))}
  </View>
))}
```

Validate `required` fields before submit (the shipped screen uses a small `isEmpty()` helper
that treats `''`, `[]`, and `false` as empty). Disable the submit button when
`form.status !== 0` (closed/archived) and show a banner.

### 4b. Flow D — submit (gasless, popup-less)

**This is the pitch.** Three steps, two of which leave the device only because they need a
server-held secret:

```tsx
import {
  uploadJson, txSubmit, signAndExecuteCustodial, sealEncryptText,
  type FieldValue, type Submission,
} from '@/lib';

async function onSubmit() {
  // 1) Assemble Submission.fields — encrypt private fields best-effort.
  const fieldValues: Record<string, FieldValue> = {};
  for (const field of fields) {
    const raw = values[field.id];
    if (isEmpty(raw)) continue;                       // omit empty optionals
    if (field.private) {
      // real Seal when WebCrypto exists, else a LABELED placeholder (never faked).
      fieldValues[field.id] = await sealEncryptText({
        formId, fieldId: field.id, text: stringify(raw),
      });
    } else {
      fieldValues[field.id] = { kind: 'plaintext', value: raw };
    }
  }
  const submission: Submission = {
    formId,
    formVersion: schema.formVersion,
    submittedAt: new Date().toISOString(),
    submitter: user.address,
    fields: fieldValues,
  };

  // 2) Sponsored Walrus upload — POST multipart to /api/walrus/upload. Returns blob_id.
  const upload = await uploadJson(submission, { owner: user.address });
  if (!upload.blobId) throw new Error('Walrus upload returned no blob_id.');

  // 3) Build submission::submit PTB and have the backend co-sign + sponsor it.
  const tx = txSubmit({ formId, blobId: upload.blobId });
  const res = await signAndExecuteCustodial(tx, user.address); // { digest, ... }

  setReceipt({ digest: res.digest, blobId: upload.blobId, walCost: upload.walCost, endEpoch: upload.endEpoch });
}
```

What's actually happening (and why it's gasless + popup-less):

- **`uploadJson(submission, { owner })`** serializes the submission to JSON bytes and POSTs them
  as multipart `file` to `/api/walrus/upload`. (RN gotcha handled inside the lib: bytes are
  staged to a cache file via `expo-file-system` because RN `FormData` can't stream raw bytes —
  you don't need to deal with this, just know `uploadJson` is the door.) The backend pays the
  WAL. The returned **`blobId` is what goes on-chain.**
- **`txSubmit({ formId, blobId })`** builds the PTB calling
  `tideform::submission::submit(&mut Form, vector<u8> blob_id, &Clock 0x6)`. The blob ID is
  encoded as `vector<u8>` of its **ASCII bytes** (`TextEncoder().encode`), *not* base64 — this
  is the #1 thing students get wrong.
- **`signAndExecuteCustodial(tx, address)`** sets the sender, serializes only the transaction
  **KIND** bytes (`onlyTransactionKind: true`), and POSTs them to `/api/wallet/sign`. The
  backend sets its sponsor wallet as gas owner, signs as both sender + sponsor, and executes.
  **0 SUI, 0 popups.**

Render a progress label per step (`Encrypting…` → `Uploading to Walrus (sponsored)…` →
`Submitting on-chain (gasless)…`), then on success show the `<Receipt>` (§7) with a "Submit
another" reset.

> **Private-field honesty (source-of-truth §7):** before the fields, show a banner keyed off
> `isSealAvailable()` — *"encryption is active"* vs *"no WebCrypto here, so private fields are
> stored as a labeled placeholder (not encrypted)."* Never claim placeholder mode is real
> encryption.

---

## 5. Flow E — Admin inbox — `app/inbox/[id].tsx`

**Web parallel:** the private triage dashboard. Reads are on-device; decryption needs the
backend (for the SessionKey signature) **and** admin rights.

Load three things, then render:

```tsx
import {
  listSubmissions, fetchForm, fetchFormSchema, fetchSubmissionPayload,
  type SubmissionObject, type Submission,
} from '@/lib';

const [f, subs] = await Promise.all([fetchForm(formId), listSubmissions(formId)]);
const schema = await fetchFormSchema(f.schemaBlobId);
subs.sort((a, b) => b.submittedAtMs - a.submittedAtMs);  // newest first
const items = await Promise.all(subs.map(async (obj) => {
  try { return { obj, payload: await fetchSubmissionPayload(obj.blobId) }; }
  catch (e) { return { obj, payloadError: String(e) }; }
}));
```

- `listSubmissions(formId)` queries `SubmissionReceived` filtered by `form_id`, then
  `multiGetObjects` → `SubmissionObject[]` (carries on-chain `status`, `priority`, `tags`,
  `submitter`, `submittedAtMs`).
- `fetchSubmissionPayload(blobId)` reads the submission JSON from Walrus.

Render each submission's fields. For a **plaintext** field, reuse `<FieldRenderer readOnly>`
with the schema field. For **private** fields, branch on the envelope:

```tsx
// value.kind === 'encrypted'
const { mode, b64, id } = value.envelope;
if (mode === 'placeholder') {
  // base64-wraps PLAINTEXT — decode and label LOUDLY as not encrypted.
  const decoded = new TextDecoder().decode(fromBase64(b64));
  // render with a "⚠ PLACEHOLDER — not encrypted" badge
} else { // mode === 'seal'
  // show "🔒 Seal-encrypted" until decrypted (see below)
}
```

### Best-effort Seal decryption

Guard the whole thing behind `isSealAvailable()` and admin status
(`form.owner === user.address || form.admins.includes(user.address)`):

```tsx
import { createCustodialSessionKey, decodeSealId, sealDecrypt, isSealAvailable } from '@/lib';
import { fromBase64 } from '@mysten/sui/utils';

async function decryptAll() {
  if (!isSealAvailable()) { setError('Seal decryption unavailable (no WebCrypto).'); return; }
  // One SessionKey for the whole pass, signed by the CUSTODIAL key via
  // /api/wallet/sign-message (replaces the wallet-popup signPersonalMessage).
  const sessionKey = await createCustodialSessionKey(user.address);
  for (const it of items) {
    for (const [fieldId, fv] of Object.entries(it.payload?.fields ?? {})) {
      if (fv.kind !== 'encrypted' || fv.envelope.mode !== 'seal' || !fv.envelope.id) continue;
      const plain = await sealDecrypt({
        formId,
        idBytes: decodeSealId(fv.envelope.id),
        ciphertext: fromBase64(fv.envelope.b64),
        sessionKey,
      });
      // store new TextDecoder().decode(plain) keyed by `${it.obj.id}:${fieldId}`
    }
  }
}
```

What `sealDecrypt` does internally: builds the form-bound approval PTB
`tideform::acl::seal_approve(idBytes, form)`, serializes its kind bytes, and asks the key
servers (via the `SessionKey` proof) to release shares. The ACL enforces *first 32 bytes of the
Seal id == form object ID* **and** *caller ∈ form.admins* — so only an admin can decrypt, and
only ciphertext bound to **this** form.

> **Honesty boundary:** if `isSealAvailable()` is false, show a documented *"decryption pending /
> unavailable on this runtime"* state — never fake a plaintext. Public fields and the
> placeholder-decode path always work.

---

## 6. `components/field-renderer.tsx` — all 14 field types, two modes

**Web parallel:** the shared `<FieldRenderer>` the public form and the admin view both use. One
component, two modes:

- **input mode** (default): an interactive control bound to `value` / `onChange`.
- **read-only mode** (`readOnly`): a type-aware display the inbox reuses.

The 14 types (source-of-truth §8): `short_text, long_text, rich_text, dropdown, multi_select,
checkbox, rating, screenshot, video, url, number, date, email, wallet`.

```tsx
import { blobUrl, type Field } from '@/lib';
import { TextInput, Switch, Pressable, Text, View, Linking } from 'react-native';

export interface FieldRendererProps {
  field: Field;
  value: unknown;
  onChange?: (value: unknown) => void;  // required in input mode
  readOnly?: boolean;                   // inbox display mode
  error?: string;
}

export function FieldRenderer({ field, value, onChange, readOnly = false, error }: FieldRendererProps) {
  return (
    <View>
      <Text>{field.label}{field.required ? ' *' : ''}{field.private ? '  🔒 private' : ''}</Text>
      {field.help ? <Text>{field.help}</Text> : null}
      {readOnly
        ? <DisplayValue field={field} value={value} />
        : <InputControl field={field} value={value} onChange={onChange ?? (() => {})} />}
      {error ? <Text>{error}</Text> : null}
    </View>
  );
}
```

`InputControl` switches on `field.type`:

| Type | Input control |
|---|---|
| `short_text` (default) | single-line `TextInput` |
| `long_text`, `rich_text` | multiline `TextInput` |
| `number` | `TextInput` `keyboardType="numeric"` |
| `email` | `TextInput` `keyboardType="email-address"`, no autocaps |
| `url` | `TextInput` `keyboardType="url"` |
| `wallet` | monospace `TextInput` (`0x…`) |
| `date` | typed `YYYY-MM-DD` `TextInput` + a "no native picker in this build" note |
| `dropdown` | single-select option list |
| `multi_select` | toggle chips (value is `string[]`) |
| `checkbox` | `Switch` (boolean) |
| `rating` | tappable stars, max from `field.validation?.maxRating ?? 5` |
| `screenshot`, `video` | `TextInput` for a Walrus blob ID **or** URL + a note |

`DisplayValue` (read-only) maps each type to a label-resolving display — e.g. `dropdown` /
`multi_select` resolve `option.value` → `option.label`, `rating` renders filled/empty stars,
and `url` / `screenshot` / `video` become tappable links (build a media URL with
`blobUrl(value)` when it isn't already an `http(s)` URL).

> **Dependency honesty (label it in the UI):** this stage ships only the base RN + Expo Router
> deps — no native date/image picker. `date` is typed and media fields take a blob ID/URL.
> Wiring `expo-image-picker` / `@react-native-community/datetimepicker` is a documented next
> step, not a silent gap.

Export it both ways so either import style works: `export function FieldRenderer` **and**
`export default FieldRenderer`.

---

## 7. `components/receipt.tsx` — the gasless receipt

**Web parallel:** the success toast/page after a submit. Surface the two artifacts every
Tideform write produces (source-of-truth §9.D):

1. the Sui **tx digest** → deep-link to **SuiVision**
2. the Walrus **blob ID** → deep-link to **Walruscan** + the raw aggregator (`blobUrl`)

```tsx
import { blobUrl, env } from '@/lib';
import { Linking, Pressable, Text, View } from 'react-native';

function suiVisionTxUrl(d: string) {
  const sub = env.network === 'mainnet' ? '' : `${env.network}.`;
  return `https://${sub}suivision.xyz/txblock/${d}`;
}
function walruscanBlobUrl(id: string) {
  const net = env.network === 'mainnet' ? 'mainnet' : 'testnet';
  return `https://walruscan.com/${net}/blob/${id}`;
}

export function Receipt({ txDigest, blobId, walCost, endEpoch }: {
  txDigest?: string; blobId?: string; walCost?: number; endEpoch?: number;
}) {
  return (
    <View>
      <Text>✓ Submitted on-chain</Text>
      <Text>⚡ 0 SUI gas · 0 popups · sponsored by Zentos</Text>
      {txDigest ? <LinkRow label="Tx digest" value={txDigest} url={suiVisionTxUrl(txDigest)} /> : null}
      {blobId ? <>
        <LinkRow label="Walrus blob" value={blobId} url={walruscanBlobUrl(blobId)} />
        <LinkRow label="Raw payload" value={blobId} url={blobUrl(blobId)} />
      </> : null}
    </View>
  );
}
```

> Explorer URLs are derived from `env.network` — they are **public explorers**, never on-chain
> IDs. Keep them out of `lib/env.ts`; they belong in the view.

---

## 8. Run the five flows and demo it

```sh
npm run lint     # typecheck the whole app against the lib contract
npm run ios      # or: npm run android  /  npm start (Expo Go)
```

Walk the grader/audience through it:

1. **A** — Continue with Google → you have a Sui address with **0 SUI**.
2. **B** — your forms list loads (on-device reads, no backend).
3. **C** — open a form; every field type renders.
4. **D** — fill + **Submit · gasless** → receipt with tx digest + Walrus blob. **Point out: no
   gas prompt, no wallet popup, no SUI in the wallet.**
5. **E** — open the Inbox; submissions render. If you're an admin and WebCrypto is available,
   **Decrypt private fields**; otherwise the labeled-pending state shows honestly.

That's the Day-2 thesis made tangible: **a mobile dApp is a thin native client over a custodial,
sponsoring backend** — gasless and popup-less, with reads staying on the device.

---

## Where to look when something breaks

| Symptom | Likely cause | Where |
|---|---|---|
| Stuck on `/login`, button disabled | `EXPO_PUBLIC_GOOGLE_CLIENT_ID` unset | `.env`, README §Google sign-in |
| Signed in but `/api/wallet/*` 401s | cookie not captured/replayed | `lib/cookies.ts` (`cookieFetch`, `captureSetCookie`) |
| Submit fails at upload | sponsored route / multipart | `lib/walrus.ts#uploadJson` |
| Submit fails at sign | KIND bytes / allowlist | `lib/api.ts#signAndExecuteCustodial` |
| Private field shows `⚠ PLACEHOLDER` | no WebCrypto on this runtime | `lib/seal.ts#isSealAvailable` (expected on stock RN) |
| Blob ID looks garbled | base64-decoding an ASCII `vector<u8>` | `lib/indexer.ts#decodeAsciiBlobId` — decode UTF-8, never base64 |
| Inbox decrypt errors for you | you're not an admin of the form | `tideform::acl::seal_approve` policy (source-of-truth §3.4) |

Authoritative contract for every line above:
[`../docs/00-architecture-source-of-truth.md`](../docs/00-architecture-source-of-truth.md).
Web → mobile mapping: [`../docs/01-web-to-mobile-map.md`](../docs/01-web-to-mobile-map.md).
The native sibling with the same lib surface:
[`../tideform-swift/README.md`](../tideform-swift/README.md).
