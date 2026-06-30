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
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { env, useAuth } from '@/lib';

const C = {
  bg: '#0B1221',
  surface: '#121C32',
  border: '#26324B',
  text: '#E7EEF8',
  muted: '#94A3B8',
  primary: '#2DD4BF',
  accent: '#60A5FA',
  danger: '#F87171',
  warn: '#FBBF24',
};

const SELLING_POINTS: { icon: string; title: string; body: string }[] = [
  {
    icon: '⚡',
    title: 'Gasless',
    body: 'A sponsor wallet pays every fee. You never hold or spend SUI.',
  },
  {
    icon: '🙅',
    title: 'Popup-less',
    body: 'No "approve in wallet" prompts. Your key signs right on the device.',
  },
  {
    icon: '🔑',
    title: 'Your key, your phone',
    body: 'A Sui wallet is created on-device and kept in the OS keystore. Non-custodial.',
  },
];

export default function LoginScreen() {
  const { signIn, ready, status, error } = useAuth();
  const busy = status === 'loading';

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
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
          {SELLING_POINTS.map((p) => (
            <View key={p.title} style={styles.point}>
              <Text style={styles.pointIcon}>{p.icon}</Text>
              <View style={styles.pointTextBlock}>
                <Text style={styles.pointTitle}>{p.title}</Text>
                <Text style={styles.pointBody}>{p.body}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.footer}>
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[styles.button, (!ready || busy) && styles.buttonDisabled]}
            onPress={() => {
              void signIn();
            }}
            disabled={!ready || busy}
          >
            {busy ? (
              <ActivityIndicator color="#06291F" />
            ) : (
              <Text style={styles.buttonText}>Create my wallet</Text>
            )}
          </Pressable>

          <Text style={styles.legal}>
            On-device wallet · gas sponsored by {hostOf(env.backendBaseUrl)}
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingVertical: 32,
    justifyContent: 'space-between',
  },
  brandBlock: { alignItems: 'center', gap: 12, marginTop: 24 },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: 'rgba(45,212,191,0.14)',
    borderColor: 'rgba(45,212,191,0.4)',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoMark: { color: C.primary, fontSize: 40, fontWeight: '900', marginTop: -4 },
  title: { color: C.text, fontSize: 32, fontWeight: '800', letterSpacing: 0.3 },
  subtitle: {
    color: C.muted,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 21,
    paddingHorizontal: 8,
  },

  points: { gap: 14 },
  point: {
    flexDirection: 'row',
    gap: 14,
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  pointIcon: { fontSize: 24 },
  pointTextBlock: { flex: 1, gap: 2 },
  pointTitle: { color: C.text, fontSize: 16, fontWeight: '700' },
  pointBody: { color: C.muted, fontSize: 13.5, lineHeight: 19 },

  footer: { gap: 12 },
  error: { color: C.danger, fontSize: 13.5, textAlign: 'center' },
  warn: { color: C.warn, fontSize: 12.5, textAlign: 'center', lineHeight: 18 },
  button: {
    backgroundColor: C.primary,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#06291F', fontSize: 16, fontWeight: '800' },
  legal: { color: C.muted, fontSize: 11.5, textAlign: 'center' },
});
