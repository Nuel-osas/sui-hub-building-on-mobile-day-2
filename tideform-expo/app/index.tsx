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
  View,
} from 'react-native';

import {
  type FormObject,
  fetchFormSchema,
  listFormsForOwner,
  useAuth,
} from '@/lib';
import { colors, mono, radius, shortAddr, space } from '@/lib/theme';
import {
  Banner,
  Card,
  Field,
  GradientButton,
  OutlineButton,
  Pill,
  Screen,
} from '@/components/ui';

const FORM_STATUS = ['OPEN', 'CLOSED', 'ARCHIVED'];
const STATUS_TONE = ['success', 'warning', 'muted'] as const;

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
    <Screen edges={['bottom']}>
      <View style={styles.headerBar}>
        <View style={{ flex: 1 }}>
          <Text style={styles.hello} numberOfLines={1}>
            {user?.name ? `Hi, ${user.name.split(' ')[0]}` : 'Your forms'}
          </Text>
          <Text style={styles.addr} numberOfLines={1}>
            {address ? shortAddr(address) : ''}
          </Text>
        </View>
        <OutlineButton
          label="Sign out"
          onPress={() => {
            void signOut();
          }}
          style={styles.signOut}
        />
      </View>

      <View style={styles.gaslessNote}>
        <Banner tone="success">
          ⚡ Submissions are sponsored — 0 SUI gas, 0 popups.
        </Banner>
      </View>

      <View style={styles.actions}>
        <GradientButton label="＋ Create form" onPress={() => router.push('/new')} />

        <View style={styles.openRow}>
          <Field
            style={styles.openField}
            value={openInput}
            onChangeText={(t) => {
              setOpenInput(t);
              if (openError) setOpenError(undefined);
            }}
            placeholder="Open a form by link or ID"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={openById}
          />
          <OutlineButton
            label="Open"
            tone="primary"
            onPress={openById}
            style={styles.openByIdBtn}
          />
        </View>
        {openError ? <Text style={styles.openError}>{openError}</Text> : null}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
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
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              {error ? (
                <>
                  <Text style={styles.emptyTitle}>Couldn't load forms</Text>
                  <Text style={styles.emptyBody}>{error}</Text>
                  <GradientButton
                    label="Retry"
                    onPress={() => void load('initial')}
                    style={styles.retry}
                  />
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
              onPress={() =>
                router.push({ pathname: '/f/[id]', params: { id: item.id } })
              }
              style={({ pressed }) => (pressed ? styles.cardPressed : null)}
            >
              <Card style={styles.card}>
                <View style={styles.cardTop}>
                  <Text style={styles.cardTitle} numberOfLines={2}>
                    {item.title}
                  </Text>
                  <Pill
                    label={FORM_STATUS[item.status] ?? `?${item.status}`}
                    tone={STATUS_TONE[item.status] ?? 'muted'}
                  />
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
              </Card>
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    gap: space.md,
  },
  hello: { color: colors.text, fontSize: 20, fontWeight: '800' },
  addr: { color: colors.muted, fontSize: 12, fontFamily: mono, marginTop: 2 },
  signOut: { paddingVertical: 10, paddingHorizontal: 16 },

  gaslessNote: {
    paddingHorizontal: space.md,
    paddingBottom: space.xs,
  },

  actions: {
    paddingHorizontal: space.md,
    paddingTop: space.xs,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  openRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  openField: { flex: 1 },
  openByIdBtn: { paddingVertical: 12, paddingHorizontal: 18 },
  openError: { color: colors.danger, fontSize: 12.5, marginTop: 1 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { padding: space.md, gap: space.md, flexGrow: 1 },

  card: { gap: space.sm },
  cardPressed: { opacity: 0.85 },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  cardTitle: { color: colors.text, fontSize: 16.5, fontWeight: '700', flex: 1 },
  cardMeta: { color: colors.muted, fontSize: 13 },
  cardActions: { flexDirection: 'row', gap: space.sm, marginTop: 2 },
  openBtn: {
    backgroundColor: '#0890BA14',
    borderColor: '#0890BA40',
    borderWidth: 1,
    borderRadius: radius.chip,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  openBtnText: { color: colors.primary, fontSize: 13.5, fontWeight: '700' },
  inboxBtn: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.chip,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  inboxBtnText: { color: colors.indigo, fontSize: 13.5, fontWeight: '700' },

  empty: {
    alignItems: 'center',
    gap: space.sm,
    paddingTop: 64,
    paddingHorizontal: space.xl,
  },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  emptyBody: {
    color: colors.muted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  retry: { marginTop: space.xs },
});
