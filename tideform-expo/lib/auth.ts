/**
 * lib/auth.ts — native Google sign-in + a tiny auth store/hook.
 *
 * Flow A (source-of-truth §9): native Google sign-in (expo-auth-session) yields a
 * Google ID-token JWT → POST /api/auth/google (lib/api.ts) → the Set-Cookie
 * session is captured (lib/cookies.ts) → we hold { address, email, name, picture }.
 * On launch, `restore()` calls GET /api/auth/me to rehydrate the session.
 *
 * There is NO wallet extension on mobile — that's the whole reason for the
 * custodial backend model. This hook is the only place the UI touches sign-in.
 */

import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import {
  type AuthUser,
  getMe,
  signInWithGoogle,
  signOut as zentosSignOut,
} from './api';
import { env } from './env';

// Required so the auth redirect can dismiss the in-app browser and return.
WebBrowser.maybeCompleteAuthSession();

// ── External auth store (framework-light, survives re-renders) ────────────────

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

// ── Store actions ─────────────────────────────────────────────────────────────

async function completeGoogleSignIn(idToken: string): Promise<void> {
  setState({ status: 'loading', error: undefined });
  try {
    const user = await signInWithGoogle(idToken);
    setState({ user, status: 'authenticated' });
  } catch (e) {
    setState({ status: 'unauthenticated', error: errorMessage(e) });
  }
}

/** Restore a persisted session via the cookie + GET /api/auth/me. */
export async function restoreSession(): Promise<void> {
  setState({ status: 'restoring', error: undefined });
  try {
    const user = await getMe();
    setState({ user, status: user ? 'authenticated' : 'unauthenticated' });
  } catch (e) {
    setState({ status: 'unauthenticated', error: errorMessage(e) });
  }
}

/** Clear the server session + local cookie + store. */
export async function signOutCurrent(): Promise<void> {
  try {
    await zentosSignOut();
  } finally {
    setState({ user: null, status: 'unauthenticated', error: undefined });
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── The hook the UI uses ──────────────────────────────────────────────────────

export interface UseAuth extends AuthState {
  isAuthenticated: boolean;
  /** True once the Google auth request has been prepared (config loaded). */
  ready: boolean;
  /** Launch native Google sign-in. Resolves the session via the backend. */
  signIn: () => Promise<void>;
  /** Sign out (clears backend session + local cookie). */
  signOut: () => Promise<void>;
  /** Re-hydrate a persisted session (call once on app launch). */
  restore: () => Promise<void>;
}

export function useAuth(): UseAuth {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // `useIdTokenAuthRequest` is the Google provider helper that returns an
  // OpenID id_token (responseType id_token + openid/email scopes) — exactly the
  // JWT POST /api/auth/google expects.
  // VERIFY: on some expo-auth-session versions this is spelled
  // `Google.useAuthRequest({ ..., responseType: 'id_token' })`; the id_token then
  // lands in `response.params.id_token` either way.
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    clientId: env.googleClientId,
  });

  useEffect(() => {
    if (!response) return;
    if (response.type === 'success') {
      const idToken =
        (response.params as Record<string, string> | undefined)?.id_token ??
        response.authentication?.idToken;
      if (idToken) {
        void completeGoogleSignIn(idToken);
      } else {
        setState({
          status: 'unauthenticated',
          error: 'Google response did not include an id_token.',
        });
      }
    } else if (response.type === 'error') {
      setState({
        status: 'unauthenticated',
        error: response.error?.message ?? 'Google sign-in failed.',
      });
    } else if (response.type === 'dismiss' || response.type === 'cancel') {
      // User backed out — return to a clean unauthenticated state.
      if (state.status === 'loading') setState({ status: 'unauthenticated' });
    }
  }, [response]);

  const signIn = useCallback(async () => {
    if (!request) return;
    setState({ status: 'loading', error: undefined });
    await promptAsync();
  }, [request, promptAsync]);

  const signOut = useCallback(() => signOutCurrent(), []);
  const restore = useCallback(() => restoreSession(), []);

  return {
    ...snapshot,
    isAuthenticated: snapshot.status === 'authenticated',
    ready: !!request,
    signIn,
    signOut,
    restore,
  };
}
