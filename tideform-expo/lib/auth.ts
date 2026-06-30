/**
 * lib/auth.ts — auth store/hook backed by a LOCAL device wallet.
 *
 * There is no wallet extension on a phone, and Google OAuth can't complete in
 * Expo Go (custom-scheme redirects aren't allowed on a Web client, and Expo
 * removed the device proxy). So the Expo-Go on-ramp is a non-custodial device
 * wallet: a Sui keypair generated + stored on-device (lib/wallet.ts). Gas stays
 * sponsored via /api/sui/sponsor (lib/local-signer.ts), so it's still gasless.
 *
 * The custodial-Google path still ships in lib/api.ts (ZentosClient) for the
 * "with a dev build" alternative; this hook is the one the screens use.
 *
 * The `useAuth` interface is intentionally unchanged from the custodial version
 * so the router guard and screens didn't have to change:
 *   { user, status, isAuthenticated, ready, signIn, signOut, restore }
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { AuthUser } from './api';
import { getOrCreateKeypair, getStoredAddress, resetWallet } from './wallet';

export type AuthStatus =
  | 'idle'
  | 'restoring'
  | 'loading'
  | 'authenticated'
  | 'unauthenticated';

export interface AuthState {
  user: AuthUser | null;
  status: AuthStatus;
  error?: string;
}

let state: AuthState = { user: null, status: 'idle' };
const listeners = new Set<() => void>();

function setState(patch: Partial<AuthState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): AuthState {
  return state;
}

/** Read the current auth state outside React (e.g. in a route guard). */
export function getAuthState(): AuthState {
  return state;
}

function userFor(address: string): AuthUser {
  // AuthUser shape is shared with the custodial path; a device wallet has no
  // email/name, so we present a friendly label.
  return { address, email: '', name: 'Device wallet' };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Store actions ─────────────────────────────────────────────────────────────

/** Rehydrate on launch: authenticated iff a device wallet already exists. */
export async function restoreSession(): Promise<void> {
  setState({ status: 'restoring', error: undefined });
  try {
    const address = await getStoredAddress();
    if (address) {
      setState({ user: userFor(address), status: 'authenticated' });
    } else {
      setState({ user: null, status: 'unauthenticated' });
    }
  } catch (e) {
    setState({ status: 'unauthenticated', error: errorMessage(e) });
  }
}

/** Create the device wallet (or enter the existing one) and authenticate. */
async function enterWallet(): Promise<void> {
  setState({ status: 'loading', error: undefined });
  try {
    const kp = await getOrCreateKeypair();
    setState({ user: userFor(kp.toSuiAddress()), status: 'authenticated' });
  } catch (e) {
    setState({ status: 'unauthenticated', error: errorMessage(e) });
  }
}

/** Forget the device wallet (a fresh one is minted next time). */
export async function signOutCurrent(): Promise<void> {
  try {
    await resetWallet();
  } finally {
    setState({ user: null, status: 'unauthenticated', error: undefined });
  }
}

// ── The hook the UI uses ──────────────────────────────────────────────────────

export interface UseAuth extends AuthState {
  isAuthenticated: boolean;
  /** Always true for the device wallet (no external config to load). */
  ready: boolean;
  /** Create / enter the on-device wallet. */
  signIn: () => Promise<void>;
  /** Forget the device wallet. */
  signOut: () => Promise<void>;
  /** Re-hydrate on launch (call once). */
  restore: () => Promise<void>;
}

export function useAuth(): UseAuth {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const signIn = useCallback(() => enterWallet(), []);
  const signOut = useCallback(() => signOutCurrent(), []);
  const restore = useCallback(() => restoreSession(), []);

  return {
    ...snapshot,
    isAuthenticated: snapshot.status === 'authenticated' && !!snapshot.user,
    ready: true,
    signIn,
    signOut,
    restore,
  };
}
