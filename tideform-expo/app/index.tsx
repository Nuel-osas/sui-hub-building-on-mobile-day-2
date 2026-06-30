/**
 * app/index.tsx — Flow B: "My Forms".
 *
 * listFormsForOwner(myAddress) (lib/indexer.ts) queries the FormCreated event by
 * the ORIGINAL package type, keeps forms whose owner == me, multiGetObjects to
 * read current Form state, then we fetch each schema blob from Walrus to show its
 * title. All of this is on-device reads against PUBLIC endpoints — no backend, no
 * cookie (source-of-truth §9.B, §12).
 *
 * Tap a form → open it (/f/[id], Flows C+D). Each row also links to its admin
 * inbox (/inbox/[id], Flow E) since these are forms you own.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  type FormObject,
  fetchFormSchema,
  listFormsForOwner,
  useAuth,
} from '@/lib';

const C = {
  bg: '#0B1221',
  surface: '#121C32',
  surface2: '#0F1830',
  border: '#26324B',
  text: '#E7EEF8',
  muted: '#94A3B8',
  primary: '#2DD4BF',
  accent: '#60A5FA',
  danger: '#F87171',
  warn: '#FBBF24',
  ok: '#34D399',
};

const FORM_STATUS = ['OPEN', 'CLOSED', 'ARCHIVED'];
const STATUS_COLOR = [C.ok, C.warn, C.muted];

interface FormRow extends FormObject {
  title: string;
}

export default function MyFormsScreen() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const address = user?.address;

  const [rows, setRows] = useState<FormRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // "Open a form by link or ID" row.
  const [openInput, setOpenInput] = useState('');
  const [openError, setOpenError] = useState<string | undefined>();

  // Pull a Sui object id out of a raw 0x id, a deep link
  // (exp://…/--/f/0x…), or an https://tidalform.xyz/f/0x… share URL.
  const openById = useCallback(() => {
    const match = openInput.match(/0x[0-9a-fA-F]{6,64}/);
    if (!match) {
      setOpenError("That doesn't look like a form link or 0x… id.");
      return;
    }
    setOpenError(undefined);
    setOpenInput('');
    router.push({ pathname: '/f/[id]', params: { id: match[0] } });
  }, [openInput, router]);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!address) return;
      mode === 'refresh' ? setRefreshing(true) : setLoading(true);
      setError(undefined);
      try {
        const forms = await listFormsForOwner(address);
        // Resolve each title from its Walrus schema blob (best-effort per form).
        const withTitles = await Promise.all(
          forms.map(async (f): Promise<FormRow> => {
            let title = '(untitled form)';
            try {
              const schema = await fetchFormSchema(f.schemaBlobId);
              if (schema?.title) title = schema.title;
            } catch {
              // A missing/old schema blob shouldn't hide the form.
            }
            return { ...f, title };
          }),
        );
        // Newest first.
        withTitles.sort((a, b) => b.createdAtMs - a.createdAtMs);
        setRows(withTitles);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [address],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.headerBar}>
        <View style={{ flex: 1 }}>
          <Text style={styles.hello} numberOfLines={1}>
            {user?.name ? `Hi, ${user.name.split(' ')[0]}` : 'Your forms'}
          </Text>
          <Text style={styles.addr} numberOfLines={1}>
            {address ? shortAddr(address) : ''}
          </Text>
        </View>
        <Pressable
          style={styles.signOut}
          onPress={() => {
            void signOut();
          }}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>

      <View style={styles.gaslessNote}>
        <Text style={styles.gaslessText}>
          ⚡ Submissions are sponsored — 0 SUI gas, 0 popups.
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable style={styles.createBtn} onPress={() => router.push('/new')}>
          <Text style={styles.createBtnText}>＋ Create form</Text>
        </Pressable>

        <View style={styles.openRow}>
          <TextInput
            style={styles.openField}
            value={openInput}
            onChangeText={(t) => {
              setOpenInput(t);
              if (openError) setOpenError(undefined);
            }}
            placeholder="Open a form by link or ID"
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={openById}
          />
          <Pressable style={styles.openByIdBtn} onPress={openById}>
            <Text style={styles.openByIdBtnText}>Open</Text>
          </Pressable>
        </View>
        {openError ? <Text style={styles.openError}>{openError}</Text> : null}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.primary} size="large" />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(f) => f.id}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void load('refresh')}
              tintColor={C.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              {error ? (
                <>
                  <Text style={styles.emptyTitle}>Couldn't load forms</Text>
                  <Text style={styles.emptyBody}>{error}</Text>
                  <Pressable
                    style={styles.retry}
                    onPress={() => void load('initial')}
                  >
                    <Text style={styles.retryText}>Retry</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={styles.emptyTitle}>No forms yet</Text>
                  <Text style={styles.emptyBody}>
                    This device wallet hasn't created any forms. Open a form's
                    shared link to fill it, or create forms on tidalform.xyz with
                    this wallet's address.
                  </Text>
                </>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.card}
              onPress={() =>
                router.push({ pathname: '/f/[id]', params: { id: item.id } })
              }
            >
              <View style={styles.cardTop}>
                <Text style={styles.cardTitle} numberOfLines={2}>
                  {item.title}
                </Text>
                <View
                  style={[
                    styles.statusPill,
                    { borderColor: STATUS_COLOR[item.status] ?? C.muted },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusText,
                      { color: STATUS_COLOR[item.status] ?? C.muted },
                    ]}
                  >
                    {FORM_STATUS[item.status] ?? `?${item.status}`}
                  </Text>
                </View>
              </View>

              <Text style={styles.cardMeta}>
                {item.submissionsCount}{' '}
                {item.submissionsCount === 1 ? 'submission' : 'submissions'} · v
                {item.version}
              </Text>

              <View style={styles.cardActions}>
                <Pressable
                  style={styles.openBtn}
                  onPress={() =>
                    router.push({ pathname: '/f/[id]', params: { id: item.id } })
                  }
                >
                  <Text style={styles.openBtnText}>Open / fill</Text>
                </Pressable>
                <Pressable
                  style={styles.inboxBtn}
                  onPress={() =>
                    router.push({
                      pathname: '/inbox/[id]',
                      params: { id: item.id },
                    })
                  }
                >
                  <Text style={styles.inboxBtnText}>
                    Inbox ({item.submissionsCount}) →
                  </Text>
                </Pressable>
              </View>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
    gap: 12,
  },
  hello: { color: C.text, fontSize: 20, fontWeight: '800' },
  addr: { color: C.muted, fontSize: 12, fontFamily: 'Courier' },
  signOut: {
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  signOutText: { color: C.muted, fontSize: 13, fontWeight: '600' },

  gaslessNote: {
    marginHorizontal: 16,
    marginBottom: 6,
    backgroundColor: 'rgba(45,212,191,0.1)',
    borderColor: 'rgba(45,212,191,0.3)',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  gaslessText: { color: C.primary, fontSize: 12.5, fontWeight: '600' },

  actions: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8, gap: 8 },
  createBtn: {
    backgroundColor: C.primary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  createBtnText: { color: '#06291F', fontSize: 15.5, fontWeight: '800' },
  openRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  openField: {
    flex: 1,
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: C.text,
    fontSize: 14,
  },
  openByIdBtn: {
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  openByIdBtnText: { color: C.accent, fontSize: 14, fontWeight: '700' },
  openError: { color: C.danger, fontSize: 12.5, marginTop: 1 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { padding: 16, gap: 12, flexGrow: 1 },

  card: {
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  cardTitle: { color: C.text, fontSize: 16.5, fontWeight: '700', flex: 1 },
  statusPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  statusText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  cardMeta: { color: C.muted, fontSize: 13 },
  cardActions: { flexDirection: 'row', gap: 10, marginTop: 2 },
  openBtn: {
    backgroundColor: 'rgba(45,212,191,0.14)',
    borderColor: 'rgba(45,212,191,0.4)',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  openBtnText: { color: C.primary, fontSize: 13.5, fontWeight: '700' },
  inboxBtn: {
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  inboxBtnText: { color: C.accent, fontSize: 13.5, fontWeight: '700' },

  empty: { alignItems: 'center', gap: 10, paddingTop: 64, paddingHorizontal: 24 },
  emptyTitle: { color: C.text, fontSize: 17, fontWeight: '700' },
  emptyBody: { color: C.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retry: {
    marginTop: 6,
    backgroundColor: C.primary,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryText: { color: '#06291F', fontWeight: '800' },
});
