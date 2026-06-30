/**
 * app/_layout.tsx — root router + auth guard for the Tideform Expo app.
 *
 * Responsibilities:
 *   1. Rehydrate a persisted Zentos session on launch (GET /api/auth/me via the
 *      stored cookie — lib/auth.ts → restore()).
 *   2. Guard the route tree: unauthenticated users are pushed to /login; an
 *      authenticated user sitting on /login is sent home. There is NO wallet
 *      extension on mobile — sign-in is the custodial Google flow (source-of-truth
 *      §6, §9.A), and this guard is the single gate.
 *   3. Mount the Stack navigator for the five screens (Flows A–E, §9).
 *
 * The auth store is framework-light (useSyncExternalStore in lib/auth.ts), so the
 * guard just reads `status`/`isAuthenticated` and redirects.
 */

// Polyfill crypto.getRandomValues for on-device Ed25519 key generation (lib/wallet.ts).
import 'react-native-get-random-values';

import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAuth } from '@/lib';

const C = {
  bg: '#0B1221',
  surface: '#121C32',
  text: '#E7EEF8',
  primary: '#2DD4BF',
  border: '#26324B',
};

/** Redirect based on auth state once the session has resolved. */
function useAuthGuard(status: string, isAuthenticated: boolean): void {
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    // Wait until the session has actually resolved before redirecting.
    if (status === 'idle' || status === 'restoring' || status === 'loading') {
      return;
    }
    const onLogin = segments[0] === 'login';
    if (!isAuthenticated && !onLogin) {
      router.replace('/login');
    } else if (isAuthenticated && onLogin) {
      router.replace('/');
    }
  }, [status, isAuthenticated, segments, router]);
}

export default function RootLayout() {
  const { status, isAuthenticated, restore } = useAuth();

  // Restore the persisted session exactly once on launch.
  useEffect(() => {
    void restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useAuthGuard(status, isAuthenticated);

  const booting = status === 'idle' || status === 'restoring';

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {booting ? (
        <View style={styles.boot}>
          <ActivityIndicator color={C.primary} size="large" />
        </View>
      ) : (
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: C.surface },
            headerTintColor: C.text,
            headerTitleStyle: { fontWeight: '700' },
            contentStyle: { backgroundColor: C.bg },
            headerShadowVisible: false,
          }}
        >
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="index" options={{ title: 'My Forms' }} />
          <Stack.Screen name="f/[id]" options={{ title: 'Form' }} />
          <Stack.Screen name="inbox/[id]" options={{ title: 'Inbox' }} />
        </Stack>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
