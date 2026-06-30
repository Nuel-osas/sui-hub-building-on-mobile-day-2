/**
 * lib/local-signer.ts — gasless signing with a LOCAL device wallet.
 *
 * The non-custodial counterpart to ZentosClient.signAndExecuteCustodial. Flow
 * (mirrors the web's lib/sponsor.ts, but the sender is the on-device key):
 *
 *   1. Build the PTB's kind-only bytes (no gas info).
 *   2. POST { txKindBytes, sender } to /api/sui/sponsor — the backend sets its
 *      sponsor wallet as gas owner + payment and signs as SPONSOR. No login /
 *      session is required by that route; it sponsors any sender.
 *   3. The on-device key signs the EXACT full bytes the sponsor returned.
 *   4. Submit both signatures. User pays 0 SUI; the key never leaves the phone.
 *
 * On-chain attribution stays correct: Submission.submitter / Form.owner are the
 * device wallet's address, because it signs as sender.
 */

import type { Transaction } from '@mysten/sui/transactions';
import { fromBase64, toBase64 } from '@mysten/sui/utils';

import { env } from './env';
import { suiClient } from './sui';
import { getOrCreateKeypair } from './wallet';

export interface LocalSignResult {
  digest: string;
  sponsorAddress: string;
  senderAddress: string;
  /** Object ID of a Form created by this tx (e.g. after form::create), if any. */
  createdFormId?: string;
}

interface SponsorResponse {
  txBytes: string;
  sponsorSig: string;
  sponsorAddress: string;
}

export async function signAndExecuteLocal(
  tx: Transaction,
): Promise<LocalSignResult> {
  const keypair = await getOrCreateKeypair();
  const sender = keypair.toSuiAddress();

  // 1. kind-only bytes (no gas yet)
  tx.setSender(sender);
  const txKindBytes = toBase64(
    await tx.build({ client: suiClient, onlyTransactionKind: true }),
  );

  // 2. sponsor adds gas + signs as sponsor (no session needed)
  const res = await fetch(`${env.backendBaseUrl}/api/sui/sponsor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txKindBytes, sender }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gas sponsorship failed (${res.status}): ${detail}`);
  }
  const { txBytes, sponsorSig, sponsorAddress } =
    (await res.json()) as SponsorResponse;

  // 3. the device key signs the exact sponsor-built bytes (sender signature)
  const { signature: senderSig } = await keypair.signTransaction(
    fromBase64(txBytes),
  );

  // 4. submit. Sui wants exactly one signature when sender === sponsor.
  const sameAddr = sender.toLowerCase() === sponsorAddress.toLowerCase();
  const signature = sameAddr ? [senderSig] : [senderSig, sponsorSig];

  const result = await suiClient.executeTransactionBlock({
    transactionBlock: txBytes,
    signature,
    options: { showEffects: true, showObjectChanges: true },
  });

  // Surface a newly-created Form's object ID (handy after form::create).
  let createdFormId: string | undefined;
  for (const ch of result.objectChanges ?? []) {
    if (
      ch.type === 'created' &&
      typeof ch.objectType === 'string' &&
      ch.objectType.endsWith('::form::Form')
    ) {
      createdFormId = ch.objectId;
      break;
    }
  }

  return { digest: result.digest, sponsorAddress, senderAddress: sender, createdFormId };
}
