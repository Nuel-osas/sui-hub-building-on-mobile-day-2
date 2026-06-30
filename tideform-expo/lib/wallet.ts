/**
 * lib/wallet.ts — a local, non-custodial device wallet.
 *
 * The Expo-Go-friendly auth model (no Google OAuth client, no dev build, no
 * native modules): the app generates an Ed25519 keypair ON DEVICE on first use
 * and stores the Bech32 secret in the OS keystore via expo-secure-store. That
 * keypair IS the user's Sui account — they hold their own key.
 *
 * Gas stays sponsored: the local key only signs as SENDER; the backend's
 * /api/sui/sponsor pays gas and co-signs (see lib/local-signer.ts). So the UX is
 * still gasless — just non-custodial instead of custodial-Google.
 *
 * Contrast with the custodial path (lib/api.ts ZentosClient): there the key lives
 * on the server behind a Google login. Here it lives on the phone. Same gasless
 * result; different custody. That contrast is a teaching beat for Day 2.
 */

// MUST be imported before any key generation — RN has no global crypto.getRandomValues.
import 'react-native-get-random-values';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import * as SecureStore from 'expo-secure-store';

/** Keystore entry holding the Bech32 `suiprivkey1…` secret. */
const STORE_KEY = 'tideform.wallet.sk';

let cached: Ed25519Keypair | null = null;

/** Load the device keypair, generating + persisting one if none exists. */
export async function getOrCreateKeypair(): Promise<Ed25519Keypair> {
  if (cached) return cached;
  const existing = await SecureStore.getItemAsync(STORE_KEY);
  if (existing) {
    cached = Ed25519Keypair.fromSecretKey(existing);
    return cached;
  }
  const kp = Ed25519Keypair.generate();
  // getSecretKey() returns the Bech32 `suiprivkey1…` form — store that.
  await SecureStore.setItemAsync(STORE_KEY, kp.getSecretKey());
  cached = kp;
  return cached;
}

/** Return the existing device keypair, or null if the wallet hasn't been created. */
export async function loadKeypair(): Promise<Ed25519Keypair | null> {
  if (cached) return cached;
  const existing = await SecureStore.getItemAsync(STORE_KEY);
  if (!existing) return null;
  cached = Ed25519Keypair.fromSecretKey(existing);
  return cached;
}

/** The device wallet's Sui address, or null if no wallet exists yet. */
export async function getStoredAddress(): Promise<string | null> {
  const kp = await loadKeypair();
  return kp ? kp.toSuiAddress() : null;
}

/** Forget the device wallet (next getOrCreateKeypair mints a fresh one). */
export async function resetWallet(): Promise<void> {
  cached = null;
  await SecureStore.deleteItemAsync(STORE_KEY);
}

/** Self-custody escape hatch — the Bech32 `suiprivkey1…` to import elsewhere. */
export async function exportSecretKey(): Promise<string | null> {
  const kp = await loadKeypair();
  return kp ? kp.getSecretKey() : null;
}
