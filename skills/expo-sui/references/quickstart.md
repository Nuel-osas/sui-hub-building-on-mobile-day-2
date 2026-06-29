# Quickstart — scaffold + a working zkLogin login screen (Day-1)

This mirrors Day-1: **non-custodial zkLogin, entirely on-device**. The user taps "Sign in
with Google", an ephemeral keypair is generated locally, a ZK proof binds it to a Sui
address, and that address signs. No wallet extension, no seed phrase.

> For the Day-2 custodial (gasless, popup-less) path, skip this file and use
> `zentos-backend.md`. Reads (`reads.md`) are shared by both.

## 1. One-command scaffold

```bash
pnpm dlx create-expo-app@latest tideform-mobile --template tabs
cd tideform-mobile

pnpm add @mysten/sui expo-auth-session expo-secure-store expo-crypto \
         expo-web-browser jwt-decode
pnpm add react-native-get-random-values   # REQUIRED crypto polyfill
```

Set the app `scheme` in `app.json` (this is your OAuth redirect namespace):

```jsonc
{ "expo": { "scheme": "tideform" } }
```

Create `.env` (or shell exports) — Expo inlines `EXPO_PUBLIC_*` at build time:

```bash
EXPO_PUBLIC_SUI_NETWORK=testnet            # Day-1 is taught on testnet
EXPO_PUBLIC_GOOGLE_CLIENT_ID=...           # VERIFY: your Google OAuth client id
```

## 2. Polyfills (import before any @mysten/sui code)

```ts
// lib/polyfills.ts
import "react-native-get-random-values";
// If you hit "TextEncoder is not defined" on older Hermes: import "fast-text-encoding";
```

## 3. The zkLogin login screen

`@mysten/sui/zklogin` gives you `generateNonce`, `generateRandomness`,
`getExtendedEphemeralPublicKey`, `jwtToAddress`, `genAddressSeed`, `getZkLoginSignature`.
The flow: ephemeral key → epoch window → nonce → Google `id_token` → salt → address.

```tsx
// app/login.tsx  — Expo Router screen
import "../lib/polyfills"; // FIRST import in the app entry path
import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  generateNonce,
  generateRandomness,
  jwtToAddress,
} from "@mysten/sui/zklogin";

WebBrowser.maybeCompleteAuthSession();

const NETWORK = (process.env.EXPO_PUBLIC_SUI_NETWORK ?? "testnet") as "testnet" | "mainnet";
const suiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });
const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID!;
const discovery = { authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth" };

// DEV salt: a stable-per-install 16-byte field element. Production must use a salt
// service keyed by the Google `sub`, so the SAME account → SAME address on every device.
// VERIFY: production salt service URL.
async function getSalt(): Promise<string> {
  let salt = await SecureStore.getItemAsync("zk.salt");
  if (!salt) {
    const bytes = Crypto.getRandomBytes(16); // < 2^128, valid zkLogin salt
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    salt = n.toString();
    await SecureStore.setItemAsync("zk.salt", salt);
  }
  return salt;
}

export default function Login() {
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const redirectUri = AuthSession.makeRedirectUri({ scheme: "tideform" });

  async function login() {
    setBusy(true);
    try {
      // 1. ephemeral keypair (lives only for this session / maxEpoch window)
      const ephemeral = Ed25519Keypair.generate();

      // 2. epoch window — proof is valid until maxEpoch
      const { epoch } = await suiClient.getLatestSuiSystemState();
      const maxEpoch = Number(epoch) + 2;

      // 3. randomness + nonce (binds the JWT to this ephemeral key)
      const randomness = generateRandomness();
      const nonce = generateNonce(ephemeral.getPublicKey(), maxEpoch, randomness);

      // 4. Google OAuth — responseType id_token, scopes openid email, nonce-bound
      const request = new AuthSession.AuthRequest({
        clientId: GOOGLE_CLIENT_ID,
        redirectUri, // MUST be registered in Google console verbatim (else redirect_uri_mismatch)
        responseType: AuthSession.ResponseType.IdToken,
        scopes: ["openid", "email"],
        extraParams: { nonce },
      });
      const result = await request.promptAsync(discovery);
      if (result.type !== "success") return;
      const jwt = result.params.id_token ?? result.authentication?.idToken;
      if (!jwt) throw new Error("no id_token returned");

      // 5. salt → 6. zkLogin address
      const salt = await getSalt();
      const zkAddress = jwtToAddress(jwt, salt);
      setAddress(zkAddress);

      // Persist what signing needs (see step 4 below). secret + maxEpoch + randomness + salt + jwt.
      await SecureStore.setItemAsync(
        "zk.session",
        JSON.stringify({
          secret: ephemeral.getSecretKey(), // Bech32 suiprivkey1… — keep in SecureStore only
          maxEpoch,
          randomness,
          salt,
          jwt,
          address: zkAddress,
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.c}>
      <Text style={styles.h}>Tideform</Text>
      {address ? (
        <Text style={styles.addr}>Signed in{"\n"}{address}</Text>
      ) : (
        <Pressable style={styles.btn} onPress={login} disabled={busy}>
          <Text style={styles.btnText}>{busy ? "…" : "Sign in with Google"}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, alignItems: "center", justifyContent: "center", gap: 24, padding: 24 },
  h: { fontSize: 28, fontWeight: "700" },
  btn: { backgroundColor: "#111", paddingVertical: 14, paddingHorizontal: 28, borderRadius: 12 },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  addr: { textAlign: "center", fontFamily: "Courier", fontSize: 12 },
});
```

## 4. Signing a transaction with zkLogin (prover round-trip)

To actually sign, fetch a ZK proof from a prover once per session, then assemble the
zkLogin signature around the ephemeral key's signature.

```ts
// lib/zklogin-sign.ts
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  getExtendedEphemeralPublicKey,
  genAddressSeed,
  getZkLoginSignature,
} from "@mysten/sui/zklogin";
import { jwtDecode } from "jwt-decode";
import type { Transaction } from "@mysten/sui/transactions";

const suiClient = new SuiClient({ url: getFullnodeUrl("testnet") });
// VERIFY: prover URL. Mysten's hosted dev/testnet prover differs from mainnet; for
// production you typically run your own prover or use a hosted one (e.g. Enoki).
const PROVER_URL = "https://prover-dev.mysten.io/v1"; // VERIFY

type ZkSession = {
  secret: string; maxEpoch: number; randomness: string; salt: string; jwt: string; address: string;
};

export async function executeWithZkLogin(tx: Transaction, session: ZkSession) {
  const ephemeral = Ed25519Keypair.fromSecretKey(session.secret);
  const extended = getExtendedEphemeralPublicKey(ephemeral.getPublicKey());

  // 1. fetch the ZK proof for this ephemeral key + JWT
  const proofRes = await fetch(PROVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jwt: session.jwt,
      extendedEphemeralPublicKey: extended,
      maxEpoch: session.maxEpoch,
      jwtRandomness: session.randomness,
      salt: session.salt,
      keyClaimName: "sub",
    }),
  });
  if (!proofRes.ok) throw new Error(`prover ${proofRes.status}`);
  const proof = await proofRes.json();

  // 2. sign the tx bytes with the ephemeral key
  tx.setSender(session.address);
  const { bytes, signature: userSignature } = await tx.sign({ client: suiClient, signer: ephemeral });

  // 3. assemble the zkLogin signature
  const decoded = jwtDecode<{ sub: string; aud: string | string[] }>(session.jwt);
  const aud = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud;
  const addressSeed = genAddressSeed(BigInt(session.salt), "sub", decoded.sub, aud).toString();
  const zkSignature = getZkLoginSignature({
    inputs: { ...proof, addressSeed },
    maxEpoch: session.maxEpoch,
    userSignature,
  });

  // 4. execute
  return suiClient.executeTransactionBlock({
    transactionBlock: bytes,
    signature: zkSignature,
    options: { showEffects: true },
  });
}
```

## 5. Funding a fresh zkLogin address (testnet)

A brand-new zkLogin address has 0 SUI. On testnet, fund it from the faucet so the user
has a balance on first launch:

```ts
import { requestSuiFromFaucetV2, getFaucetHost } from "@mysten/sui/faucet";
await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: session.address });
```

On **mainnet** there is no faucet — this is exactly why Day-2 switches to a **sponsored**
model so the user never needs SUI at all. See `zentos-backend.md`.

## Where to go next

- Read on-chain forms/submissions + Walrus blobs → `reads.md` (works for both auth models).
- Gasless, popup-less submit + uploads → `zentos-backend.md`.
- Stuck on `redirect_uri_mismatch`, salts, or crypto polyfills → `patterns.md`.
