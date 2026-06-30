/**
 * app/login.tsx — Flow A: native Google sign-in → custodial Sui wallet.
 *
 * There is no wallet extension on a phone (source-of-truth §12), so sign-in is the
 * whole on-ramp. expo-auth-session yields a Google ID token → POST /api/auth/google
 * mints/loads a custodial Sui wallet and sets a session cookie (captured in
 * lib/cookies.ts). Same Google account → same Sui address forever (§6.1).
 *
 * The headline UX is framed here up front: no seed phrase, no gas, no popups — the
 * Zentos backend sponsors and dual-signs every transaction (§6.2).
 *
 * All sign-in logic lives in the `useAuth` hook (lib/auth.ts); this screen is pure
 * presentation + a button.
 */

import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

import { env, useAuth } from '@/lib';
import {
  Banner,
  Card,
  GradientButton,
  Screen,
  SectionLabel,
} from '@/components/ui';
import { colors, space } from '@/lib/theme';

const SELLING_POINTS: { icon: string; title: string; body: string; tint: string }[] = [
  {
    icon: '⚡',
    title: 'Gasless',
    body: 'A sponsor wallet pays every fee. You never hold or spend SUI.',
    tint: colors.warning,
  },
  {
    icon: '🙅',
    title: 'Popup-less',
    body: 'No "approve in wallet" prompts. Your key signs right on the device.',
    tint: colors.teal,
  },
  {
    icon: '🔑',
    title: 'Your key, your phone',
    body: 'A Sui wallet is created on-device and kept in the OS keystore. Non-custodial.',
    tint: colors.indigo,
  },
];

export default function LoginScreen() {
  const { signIn, ready, status, error } = useAuth();
  const busy = status === 'loading';

  return (
    <Screen edges={['top', 'bottom']}>
      <StatusBar style="dark" />
      <View style={styles.container}>
        <View style={styles.brandBlock}>
          <View style={styles.logo}>
            <Text style={styles.logoMark}>≈</Text>
          </View>
          <Text style={styles.title}>Tideform</Text>
          <Text style={styles.subtitle}>
            Walrus-native forms on Sui. Collect submissions on-chain — gasless and
            popup-less.
          </Text>
        </View>

        <View style={styles.points}>
          <SectionLabel>Why Tideform</SectionLabel>
          {SELLING_POINTS.map((p) => (
            <Card key={p.title} style={styles.point}>
              <View style={[styles.pointIcon, { backgroundColor: p.tint + '14', borderColor: p.tint + '40' }]}>
                <Text style={styles.pointIconText}>{p.icon}</Text>
              </View>
              <View style={styles.pointTextBlock}>
                <Text style={styles.pointTitle}>{p.title}</Text>
                <Text style={styles.pointBody}>{p.body}</Text>
              </View>
            </Card>
          ))}
        </View>

        <View style={styles.footer}>
          {error ? <Banner tone="danger">{error}</Banner> : null}

          <GradientButton
            label="Create my wallet"
            loadingLabel="Creating…"
            loading={busy}
            disabled={!ready || busy}
            onPress={() => {
              void signIn();
            }}
          />

          <Text style={styles.legal}>
            On-device wallet · gas sponsored by {hostOf(env.backendBaseUrl)}
          </Text>
        </View>
      </View>
    </Screen>
  );
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: space.xl,
    paddingVertical: space.xl,
    justifyContent: 'space-between',
  },

  brandBlock: { alignItems: 'center', gap: space.sm, marginTop: space.xl },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: colors.primary + '14',
    borderColor: colors.primary + '40',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoMark: { color: colors.primary, fontSize: 40, fontWeight: '900', marginTop: -4 },
  title: { color: colors.text, fontSize: 32, fontWeight: '800', letterSpacing: 0.3 },
  subtitle: {
    color: colors.muted,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 21,
    paddingHorizontal: 8,
  },

  points: { gap: space.md },
  point: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'center',
  },
  pointIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pointIconText: { fontSize: 22 },
  pointTextBlock: { flex: 1, gap: 2 },
  pointTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  pointBody: { color: colors.muted, fontSize: 13.5, lineHeight: 19 },

  footer: { gap: space.md },
  legal: { color: colors.subtle, fontSize: 11.5, textAlign: 'center' },
});
