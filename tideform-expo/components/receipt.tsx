/**
 * components/receipt.tsx — the success receipt for a gasless, popup-less submit.
 *
 * Surfaces the two artifacts every Tideform write produces (source-of-truth §9.D):
 *   1. the Sui transaction DIGEST  → deep-linked to SuiVision
 *   2. the Walrus BLOB ID          → deep-linked to Walruscan + the raw aggregator
 *
 * The headline UX lives here: the badge spells out that the user paid 0 SUI gas and
 * saw 0 wallet popups, because the Zentos backend sponsored + dual-signed the tx.
 *
 * Explorer URLs below are PUBLIC explorers (suivision.xyz / walruscan.com), not
 * on-chain identifiers — they are derived from `env.network`, never hard-coded IDs.
 */

import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { blobUrl, env } from '@/lib';
import { colors } from '@/lib/theme';

// Tidalform light theme, mapped onto this file's local keys.
const C = {
  surface: colors.surface,
  border: colors.border,
  text: colors.text,
  muted: colors.muted,
  primary: colors.primary,
  accent: colors.primary,
  ok: colors.success,
};

export interface ReceiptProps {
  /** Sui transaction digest from signAndExecuteCustodial(). */
  txDigest?: string;
  /** Walrus blob ID the payload was stored under (this is what went on-chain). */
  blobId?: string;
  /** Optional sponsor cost / storage window returned by the upload route. */
  walCost?: number;
  endEpoch?: number;
  /** Heading override (e.g. "Submission stored"). */
  title?: string;
}

/** Public Sui explorer for a tx digest, network-aware. */
function suiVisionTxUrl(digest: string): string {
  const sub = env.network === 'mainnet' ? '' : `${env.network}.`;
  return `https://${sub}suivision.xyz/txblock/${digest}`;
}

/** Public Walrus explorer for a blob ID, network-aware. */
function walruscanBlobUrl(blobId: string): string {
  const net = env.network === 'mainnet' ? 'mainnet' : 'testnet';
  return `https://walruscan.com/${net}/blob/${blobId}`;
}

function short(s: string, head = 10, tail = 8): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function LinkRow({
  label,
  value,
  url,
}: {
  label: string;
  value: string;
  url: string;
}) {
  return (
    <Pressable
      style={styles.row}
      onPress={() => {
        void Linking.openURL(url);
      }}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {short(value)}
      </Text>
      <Text style={styles.open}>open ↗</Text>
    </Pressable>
  );
}

export function Receipt({
  txDigest,
  blobId,
  walCost,
  endEpoch,
  title = 'Submitted on-chain',
}: ReceiptProps) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.check}>✓</Text>
        <Text style={styles.title}>{title}</Text>
      </View>

      <View style={styles.badge}>
        <Text style={styles.badgeText}>
          ⚡ 0 SUI gas · 0 popups · sponsored by Zentos
        </Text>
      </View>

      {txDigest ? (
        <LinkRow label="Tx digest" value={txDigest} url={suiVisionTxUrl(txDigest)} />
      ) : null}

      {blobId ? (
        <>
          <LinkRow
            label="Walrus blob"
            value={blobId}
            url={walruscanBlobUrl(blobId)}
          />
          <LinkRow label="Raw payload" value={blobId} url={blobUrl(blobId)} />
        </>
      ) : null}

      {(walCost != null || endEpoch != null) && (
        <Text style={styles.meta}>
          {walCost != null ? `WAL cost ${walCost} (paid by sponsor)` : ''}
          {walCost != null && endEpoch != null ? '  ·  ' : ''}
          {endEpoch != null ? `stored through epoch ${endEpoch}` : ''}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  check: {
    color: '#FFFFFF',
    backgroundColor: C.ok,
    width: 26,
    height: 26,
    borderRadius: 13,
    textAlign: 'center',
    lineHeight: 26,
    fontWeight: '900',
    overflow: 'hidden',
  },
  title: { color: C.text, fontSize: 17, fontWeight: '700' },
  badge: {
    backgroundColor: '#0890BA14',
    borderColor: '#0890BA40',
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
  },
  badgeText: { color: C.primary, fontWeight: '700', fontSize: 12.5 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surfaceLift,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  rowLabel: { color: C.muted, fontSize: 12.5, width: 92 },
  rowValue: {
    color: C.text,
    fontSize: 13,
    flex: 1,
    fontFamily: 'Courier',
  },
  open: { color: C.accent, fontSize: 12.5, fontWeight: '700' },
  meta: { color: C.muted, fontSize: 12 },
});

export default Receipt;
