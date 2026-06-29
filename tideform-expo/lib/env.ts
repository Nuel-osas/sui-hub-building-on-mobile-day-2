/**
 * lib/env.ts — single source of runtime configuration.
 *
 * Every value is read from an EXPO_PUBLIC_* variable (inlined into the bundle by
 * Expo) and falls back to the production MAINNET default from the architecture
 * source-of-truth, so the app runs out of the box. Override via `.env`.
 *
 * This is the `env` member of the shared mobile lib contract — the Swift `Lib/`
 * exposes the same named fields.
 */

export type SuiNetwork = 'mainnet' | 'testnet' | 'devnet' | 'localnet';

// ── Mainnet defaults (from docs/00-architecture-source-of-truth.md) ───────────
const DEFAULT_NETWORK: SuiNetwork = 'mainnet';
const DEFAULT_PACKAGE_ID =
  '0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4';
const DEFAULT_ORIGINAL_PACKAGE_ID =
  '0xeafe4800dc71923b1e743f199738aa85fbdc6c8cec55ff138f0d69ee6da72dd4';
const DEFAULT_WALRUS_AGGREGATOR =
  'https://aggregator.walrus-mainnet.walrus.space';
const DEFAULT_BACKEND_BASE_URL = 'https://tidalform.xyz';
const DEFAULT_SEAL_KEY_SERVERS =
  '0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a';
const DEFAULT_SEAL_THRESHOLD = 1;

function str(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim();
  return v.length > 0 ? v : fallback;
}

function csv(value: string | undefined, fallback: string): string[] {
  return str(value, fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface Env {
  /** Sui network the read-side fullnode client targets. */
  network: SuiNetwork;
  /** `published-at` package ID — used as the prefix for moveCall targets. */
  packageId: string;
  /** `original-id` package ID — used for event TYPE queries (stable across upgrades). */
  originalPackageId: string;
  /** Public Walrus aggregator base URL for device-side blob reads. */
  walrusAggregator: string;
  /** Zentos backend base URL: custodial auth, sponsored signing, sponsored upload. */
  backendBaseUrl: string;
  /** Google OAuth client ID for native sign-in via expo-auth-session. */
  googleClientId: string;
  /** Seal key-server object IDs. */
  sealKeyServers: string[];
  /** Seal decryption threshold (shares required). */
  sealThreshold: number;
}

export const env: Env = {
  network: str(process.env.EXPO_PUBLIC_SUI_NETWORK, DEFAULT_NETWORK) as SuiNetwork,
  packageId: str(process.env.EXPO_PUBLIC_TIDEFORM_PACKAGE_ID, DEFAULT_PACKAGE_ID),
  originalPackageId: str(
    process.env.EXPO_PUBLIC_TIDEFORM_ORIGINAL_PACKAGE_ID,
    DEFAULT_ORIGINAL_PACKAGE_ID,
  ),
  walrusAggregator: str(
    process.env.EXPO_PUBLIC_WALRUS_AGGREGATOR,
    DEFAULT_WALRUS_AGGREGATOR,
  ),
  backendBaseUrl: str(
    process.env.EXPO_PUBLIC_BACKEND_BASE_URL,
    DEFAULT_BACKEND_BASE_URL,
  ).replace(/\/+$/, ''),
  googleClientId: str(process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID, ''),
  sealKeyServers: csv(
    process.env.EXPO_PUBLIC_SEAL_KEY_SERVERS,
    DEFAULT_SEAL_KEY_SERVERS,
  ),
  sealThreshold: int(process.env.EXPO_PUBLIC_SEAL_THRESHOLD, DEFAULT_SEAL_THRESHOLD),
};
