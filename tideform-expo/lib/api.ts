/**
 * lib/api.ts — ZentosClient: the thin native client over the Zentos backend.
 *
 * Zentos = "Custodial Google → Sui wallet for apps" (source-of-truth §6). The
 * whole point of Day 2: mobile does NOT rebuild auth/signing/gas — it is JUST a
 * client over these HTTP routes. Privileged calls carry the session cookie
 * captured in lib/cookies.ts.
 *
 * Auth:  signInWithGoogle(idToken), getMe(), signOut()
 * Sign:  signAndExecuteCustodial(tx, address), custodialSignMessage(message)
 *
 * The headline UX — GASLESS + POPUP-LESS — lives in signAndExecuteCustodial:
 * we send only the transaction KIND bytes; the backend sets its sponsor wallet as
 * gas owner and signs as both sender (the user) and sponsor. User pays 0 SUI and
 * sees 0 popups.
 */

import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';

import { clearCookie, cookieFetch } from './cookies';
import { env } from './env';
import { suiClient } from './sui';

// ── Response shapes ───────────────────────────────────────────────────────────

export interface AuthUser {
  address: string;
  email: string;
  name: string;
  picture?: string;
  /** Only present on first sign-in (POST /api/auth/google). */
  isNew?: boolean;
  /** Only present on GET /api/auth/me — true if the user exported their key. */
  isExported?: boolean;
}

export interface SignResult {
  digest: string;
  sponsorAddress: string;
  senderAddress: string;
}

export interface SignMessageResult {
  /** base64 signature. */
  signature: string;
  address: string;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ZentosClient {
  constructor(private readonly baseUrl: string = env.backendBaseUrl) {}

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await cookieFetch(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ApiError(`${path} failed: ${res.status} ${detail}`, res.status);
    }
    return (await res.json()) as T;
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  /**
   * Exchange a Google ID-token JWT for a custodial Sui wallet + session cookie.
   * Same Google account → same Sui address forever. The Set-Cookie is captured
   * automatically by cookieFetch.
   */
  async signInWithGoogle(idToken: string): Promise<AuthUser> {
    return this.postJson<AuthUser>('/api/auth/google', { idToken });
  }

  /** Restore the session on launch. Returns null when not signed in (401). */
  async getMe(): Promise<AuthUser | null> {
    const res = await cookieFetch(this.url('/api/auth/me'), { method: 'GET' });
    if (res.status === 401) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ApiError(`/api/auth/me failed: ${res.status} ${detail}`, res.status);
    }
    return (await res.json()) as AuthUser;
  }

  /** Clear the server session and forget the local cookie. */
  async signOut(): Promise<void> {
    try {
      await cookieFetch(this.url('/api/auth/logout'), { method: 'POST' });
    } finally {
      await clearCookie();
    }
  }

  // ── Signing (custodial + sponsored) ───────────────────────────────────────────

  /**
   * Build the transaction KIND bytes and have the backend co-sign + execute as
   * sponsor and sender. Gasless + popup-less. Mirrors web's signer.ts:
   *
   *   tx.setSender(address)
   *   kindBytes = toBase64(await tx.build({ onlyTransactionKind: true }))
   *   POST /api/wallet/sign { txKindBytes: kindBytes } → { digest, ... }
   */
  async signAndExecuteCustodial(
    tx: Transaction,
    address: string,
  ): Promise<SignResult> {
    tx.setSender(address);
    const kindBytes = toBase64(
      await tx.build({ client: suiClient, onlyTransactionKind: true }),
    );
    return this.postJson<SignResult>('/api/wallet/sign', { txKindBytes: kindBytes });
  }

  /**
   * Sign a personal message with the custodial key. This is what Seal's
   * SessionKey flow needs (proof-of-ownership before key servers release shares);
   * on mobile it replaces the wallet-popup `signPersonalMessage`.
   *
   * @param message raw message bytes (base64-encoded for the wire).
   */
  async custodialSignMessage(message: Uint8Array): Promise<SignMessageResult> {
    return this.postJson<SignMessageResult>('/api/wallet/sign-message', {
      message: toBase64(message),
    });
  }

  /** Self-custody escape hatch — returns a Bech32 `suiprivkey1…` string. */
  async exportKey(): Promise<{ privateKey: string }> {
    return this.postJson<{ privateKey: string }>('/api/wallet/export', {});
  }
}

// ── Singleton + bound functions (the lib contract surface) ────────────────────

/** Shared default client pointed at env.backendBaseUrl. */
export const zentos = new ZentosClient();

export const signInWithGoogle = (idToken: string): Promise<AuthUser> =>
  zentos.signInWithGoogle(idToken);
export const getMe = (): Promise<AuthUser | null> => zentos.getMe();
export const signOut = (): Promise<void> => zentos.signOut();
export const signAndExecuteCustodial = (
  tx: Transaction,
  address: string,
): Promise<SignResult> => zentos.signAndExecuteCustodial(tx, address);
export const custodialSignMessage = (
  message: Uint8Array,
): Promise<SignMessageResult> => zentos.custodialSignMessage(message);
