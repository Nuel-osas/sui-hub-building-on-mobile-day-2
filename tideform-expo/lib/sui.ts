/**
 * lib/sui.ts — the read-side Sui fullnode client.
 *
 * This is the `suiClient` member of the shared mobile lib contract. Reads
 * (queryEvents, multiGetObjects, getObject) go straight from the device against
 * the public fullnode — no backend needed. Writes are sponsored + custodial and
 * go through Zentos (see lib/api.ts).
 */

// `react-native-get-random-values` patches global `crypto.getRandomValues`,
// which @mysten/sui (and @mysten/seal) require under Hermes/JSC. Importing it
// here, at the root of the lib graph, guarantees it loads before any SDK call.
import 'react-native-get-random-values';

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

import { env } from './env';

export const suiClient = new SuiClient({
  url: getFullnodeUrl(env.network),
});
