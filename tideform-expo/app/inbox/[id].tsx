/**
 * app/inbox/[id].tsx — Flow E: admin inbox.
 *
 * listSubmissions(formId) (lib/indexer.ts) queries SubmissionReceived filtered by
 * form_id, multiGetObjects for current Submission state, then we fetch each payload
 * blob from Walrus and render it with <FieldRenderer readOnly> using the form's
 * schema. All reads are on-device against public endpoints (§9.E, §12).
 *
 * Private fields:
 *   • plaintext            → shown directly.
 *   • encrypted (placeholder) → decoded + clearly labeled "NOT encrypted" (the
 *     submit device had no WebCrypto; lib/seal.ts is honest about this).
 *   • encrypted (seal)     → BEST-EFFORT decrypt: createCustodialSessionKey()
 *     signs the Seal SessionKey via /api/wallet/sign-message (custodial), then
 *     sealDecrypt() builds the form-bound acl::seal_approve PTB and asks the key
 *     servers to release shares. If WebCrypto is absent this is a documented
 *     "decryption pending" state — never faked.
 *
 * Decryption requires you to be an admin/owner of the form (the acl policy).
 */

import { useLocalSearchParams } from 'expo-router';
import { fromBase64 } from '@mysten/sui/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  type Field,
  type FieldValue,
  type FormObject,
  type FormSchema,
  type Submission,
  type SubmissionObject,
  createCustodialSessionKey,
  decodeSealId,
  fetchForm,
  fetchFormSchema,
  fetchSubmissionPayload,
  isSealAvailable,
  listSubmissions,
  sealDecrypt,
  signAndExecuteLocal,
  txAddTag,
  txSubmissionPriority,
  txSubmissionStatus,
  useAuth,
} from '@/lib';
import { FieldRenderer } from '@/components/field-renderer';

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

const SUB_STATUS = ['NEW', 'IN PROGRESS', 'RESOLVED', 'SPAM'];
const PRIORITY = ['LOW', 'MED', 'HIGH', 'URGENT'];
const PRIORITY_COLOR = [C.muted, C.accent, C.warn, C.danger];

interface InboxItem {
  obj: SubmissionObject;
  payload?: Submission;
  payloadError?: string;
}

/** key `${submissionId}:${fieldId}` → decrypted plaintext (or an error marker). */
type DecryptMap = Record<string, { text?: string; error?: string }>;

export default function InboxScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const formId = String(id ?? '');
  const { user } = useAuth();

  const [form, setForm] = useState<FormObject | null>(null);
  const [schema, setSchema] = useState<FormSchema | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();

  const [decrypting, setDecrypting] = useState(false);
  const [decrypted, setDecrypted] = useState<DecryptMap>({});
  // Cache the SessionKey across fields (its type is inferred — no import needed).
  const sessionRef = useRef<Awaited<
    ReturnType<typeof createCustodialSessionKey>
  > | null>(null);

  const fieldMap = useMemo(() => {
    const map = new Map<string, Field>();
    if (schema) {
      for (const f of schema.sections.flatMap((s) => s.fields)) map.set(f.id, f);
    }
    return map;
  }, [schema]);

  const isAdmin = useMemo(() => {
    if (!form || !user?.address) return false;
    return (
      form.owner === user.address || form.admins.includes(user.address)
    );
  }, [form, user?.address]);

  const hasSealCiphertext = useMemo(
    () =>
      items.some((it) =>
        Object.values(it.payload?.fields ?? {}).some(
          (fv) => fv.kind === 'encrypted' && fv.envelope.mode === 'seal',
        ),
      ),
    [items],
  );

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      mode === 'refresh' ? setRefreshing(true) : setLoading(true);
      setError(undefined);
      try {
        const [f, subs] = await Promise.all([
          fetchForm(formId),
          listSubmissions(formId),
        ]);
        if (!f) throw new Error('Form not found on-chain.');
        const s = await fetchFormSchema(f.schemaBlobId);

        // Newest first by on-chain timestamp.
        subs.sort((a, b) => b.submittedAtMs - a.submittedAtMs);
        const loaded = await Promise.all(
          subs.map(async (obj): Promise<InboxItem> => {
            try {
              const payload = await fetchSubmissionPayload(obj.blobId);
              return { obj, payload };
            } catch (e) {
              return {
                obj,
                payloadError: e instanceof Error ? e.message : String(e),
              };
            }
          }),
        );

        setForm(f);
        setSchema(s);
        setItems(loaded);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [formId],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  // Optimistically patch one submission's on-chain fields after an admin action
  // succeeds — keeps the header pills/tags in sync without a full reload.
  const patchItem = useCallback(
    (submissionId: string, patch: Partial<SubmissionObject>) => {
      setItems((prev) =>
        prev.map((it) =>
          it.obj.id === submissionId
            ? { ...it, obj: { ...it.obj, ...patch } }
            : it,
        ),
      );
    },
    [],
  );

  async function decryptAll(): Promise<void> {
    if (!form || !user?.address) return;
    if (!isSealAvailable()) {
      setError(
        'Seal decryption is unavailable on this runtime (no WebCrypto). ' +
          'Private fields stay sealed — this is a documented mobile limitation.',
      );
      return;
    }
    setDecrypting(true);
    setError(undefined);
    try {
      // One SessionKey for the whole pass; signed by the custodial key via
      // /api/wallet/sign-message (replaces the wallet popup).
      const sessionKey =
        sessionRef.current ??
        (await createCustodialSessionKey(user.address));
      sessionRef.current = sessionKey;

      const next: DecryptMap = { ...decrypted };
      for (const it of items) {
        for (const [fieldId, fv] of Object.entries(it.payload?.fields ?? {})) {
          if (fv.kind !== 'encrypted' || fv.envelope.mode !== 'seal') continue;
          const key = `${it.obj.id}:${fieldId}`;
          if (next[key]?.text != null) continue;
          if (!fv.envelope.id) {
            next[key] = { error: 'missing seal id' };
            continue;
          }
          try {
            const idBytes = decodeSealId(fv.envelope.id);
            const ciphertext = fromBase64(fv.envelope.b64);
            const plain = await sealDecrypt({
              formId,
              idBytes,
              ciphertext,
              sessionKey,
            });
            next[key] = { text: new TextDecoder().decode(plain) };
          } catch (e) {
            next[key] = { error: e instanceof Error ? e.message : String(e) };
          }
        }
      }
      setDecrypted(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDecrypting(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={C.primary} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={C.primary}
          />
        }
      >
        <Text style={styles.title}>{schema?.title ?? 'Inbox'}</Text>
        <Text style={styles.subtitle}>
          {items.length} {items.length === 1 ? 'submission' : 'submissions'}
          {form ? ` · ${form.admins.length + 1} admin(s)` : ''}
        </Text>

        {!isAdmin ? (
          <View style={[styles.banner, styles.bannerWarn]}>
            <Text style={styles.bannerWarnText}>
              You are not an admin of this form. Public fields are visible, but
              private (Seal) fields can only be decrypted by the form's admins.
            </Text>
          </View>
        ) : null}

        {error ? (
          <View style={[styles.banner, styles.bannerErr]}>
            <Text style={styles.bannerErrText}>{error}</Text>
          </View>
        ) : null}

        {hasSealCiphertext && isAdmin ? (
          <Pressable
            style={[styles.decryptBtn, decrypting && styles.btnDisabled]}
            onPress={() => void decryptAll()}
            disabled={decrypting}
          >
            {decrypting ? (
              <View style={styles.btnBusy}>
                <ActivityIndicator color="#06291F" />
                <Text style={styles.decryptText}>Decrypting…</Text>
              </View>
            ) : (
              <Text style={styles.decryptText}>
                🔓 Decrypt private fields {isSealAvailable() ? '' : '(unavailable)'}
              </Text>
            )}
          </Pressable>
        ) : null}

        {items.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No submissions yet</Text>
            <Text style={styles.emptyBody}>
              When someone submits this form, it lands here.
            </Text>
          </View>
        ) : (
          items.map((it) => (
            <SubmissionCard
              key={it.obj.id}
              item={it}
              fieldMap={fieldMap}
              decrypted={decrypted}
              formId={formId}
              isAdmin={isAdmin}
              onPatch={(patch) => patchItem(it.obj.id, patch)}
              onRefresh={() => void load('refresh')}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── One submission card ────────────────────────────────────────────────────────

function SubmissionCard({
  item,
  fieldMap,
  decrypted,
  formId,
  isAdmin,
  onPatch,
  onRefresh,
}: {
  item: InboxItem;
  fieldMap: Map<string, Field>;
  decrypted: DecryptMap;
  formId: string;
  isAdmin: boolean;
  onPatch: (patch: Partial<SubmissionObject>) => void;
  onRefresh: () => void;
}) {
  const { obj, payload, payloadError } = item;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardWhen}>
            {new Date(obj.submittedAtMs).toLocaleString()}
          </Text>
          <Text style={styles.cardWho} numberOfLines={1}>
            {obj.submitter ? shortAddr(obj.submitter) : 'anonymous'}
          </Text>
        </View>
        <View style={styles.pills}>
          <View style={styles.statusPill}>
            <Text style={styles.statusText}>
              {SUB_STATUS[obj.status] ?? `?${obj.status}`}
            </Text>
          </View>
          <View
            style={[
              styles.prioPill,
              { borderColor: PRIORITY_COLOR[obj.priority] ?? C.muted },
            ]}
          >
            <Text
              style={[
                styles.prioText,
                { color: PRIORITY_COLOR[obj.priority] ?? C.muted },
              ]}
            >
              {PRIORITY[obj.priority] ?? '?'}
            </Text>
          </View>
        </View>
      </View>

      {obj.tags.length > 0 ? (
        <View style={styles.tagRow}>
          {obj.tags.map((t) => (
            <View key={t} style={styles.tag}>
              <Text style={styles.tagText}>#{t}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {isAdmin ? (
        <AdminActions
          obj={obj}
          formId={formId}
          onPatch={onPatch}
          onRefresh={onRefresh}
        />
      ) : null}

      <View style={styles.divider} />

      {payloadError ? (
        <Text style={styles.fieldError}>
          Couldn't load payload blob: {payloadError}
        </Text>
      ) : payload ? (
        Object.entries(payload.fields).map(([fieldId, fv]) => (
          <SubmittedField
            key={fieldId}
            field={fieldMap.get(fieldId)}
            fieldId={fieldId}
            value={fv}
            decrypted={decrypted[`${obj.id}:${fieldId}`]}
          />
        ))
      ) : (
        <Text style={styles.fieldError}>Empty payload.</Text>
      )}
    </View>
  );
}

// ── Admin action bar (rendered only for form owners/admins) ─────────────────────

function AdminActions({
  obj,
  formId,
  onPatch,
  onRefresh,
}: {
  obj: SubmissionObject;
  formId: string;
  onPatch: (patch: Partial<SubmissionObject>) => void;
  onRefresh: () => void;
}) {
  // `busy` holds the key of the in-flight action so we can show a spinner on
  // exactly that control; everything else disables while one is running.
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>();
  const [tagText, setTagText] = useState('');

  // Run a builder → sign+sponsor on-device, then optimistically patch the item.
  async function run(
    key: string,
    build: () => Parameters<typeof signAndExecuteLocal>[0],
    patch: Partial<SubmissionObject>,
  ): Promise<boolean> {
    setBusy(key);
    setActionError(undefined);
    try {
      await signAndExecuteLocal(build());
      onPatch(patch);
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      // Fall back to a fresh read so the UI never lies about on-chain state.
      onRefresh();
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function addTag(): Promise<void> {
    const tag = tagText.trim();
    if (!tag || obj.tags.includes(tag)) {
      setTagText('');
      return;
    }
    const ok = await run(
      'tag',
      () => txAddTag({ formId, submissionId: obj.id, tag }),
      { tags: [...obj.tags, tag] },
    );
    if (ok) setTagText('');
  }

  const disabled = busy != null;

  return (
    <View style={styles.adminBar}>
      <Text style={styles.adminLabel}>Status</Text>
      <View style={styles.adminRow}>
        {SUB_STATUS.map((label, i) => {
          const active = obj.status === i;
          const key = `status-${i}`;
          return (
            <Pressable
              key={label}
              disabled={disabled || active}
              onPress={() =>
                void run(
                  key,
                  () =>
                    txSubmissionStatus({
                      formId,
                      submissionId: obj.id,
                      status: i,
                    }),
                  { status: i },
                )
              }
              style={[
                styles.adminPill,
                active && styles.adminPillActive,
                disabled && !active && styles.adminPillFaded,
              ]}
            >
              {busy === key ? (
                <ActivityIndicator size="small" color={C.primary} />
              ) : (
                <Text
                  style={[
                    styles.adminPillText,
                    active && styles.adminPillTextActive,
                  ]}
                >
                  {label}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.adminLabel}>Priority</Text>
      <View style={styles.adminRow}>
        {PRIORITY.map((label, i) => {
          const active = obj.priority === i;
          const color = PRIORITY_COLOR[i] ?? C.muted;
          const key = `prio-${i}`;
          return (
            <Pressable
              key={label}
              disabled={disabled || active}
              onPress={() =>
                void run(
                  key,
                  () =>
                    txSubmissionPriority({
                      formId,
                      submissionId: obj.id,
                      priority: i,
                    }),
                  { priority: i },
                )
              }
              style={[
                styles.adminPill,
                active && { borderColor: color, backgroundColor: C.surface2 },
                disabled && !active && styles.adminPillFaded,
              ]}
            >
              {busy === key ? (
                <ActivityIndicator size="small" color={color} />
              ) : (
                <Text
                  style={[
                    styles.adminPillText,
                    active && { color, fontWeight: '800' },
                  ]}
                >
                  {label}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.adminLabel}>Add tag</Text>
      <View style={styles.tagAddRow}>
        <TextInput
          value={tagText}
          onChangeText={setTagText}
          placeholder="e.g. follow-up"
          placeholderTextColor={C.muted}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          onSubmitEditing={() => void addTag()}
          style={styles.tagInput}
        />
        <Pressable
          disabled={disabled || tagText.trim().length === 0}
          onPress={() => void addTag()}
          style={[
            styles.tagAddBtn,
            (disabled || tagText.trim().length === 0) && styles.btnDisabled,
          ]}
        >
          {busy === 'tag' ? (
            <ActivityIndicator size="small" color="#06291F" />
          ) : (
            <Text style={styles.tagAddBtnText}>Add</Text>
          )}
        </Pressable>
      </View>

      {actionError ? (
        <Text style={styles.adminError}>{actionError}</Text>
      ) : null}
    </View>
  );
}

// ── One field within a submission ──────────────────────────────────────────────

function SubmittedField({
  field,
  fieldId,
  value,
  decrypted,
}: {
  field: Field | undefined;
  fieldId: string;
  value: FieldValue;
  decrypted?: { text?: string; error?: string };
}) {
  const label = field?.label ?? fieldId;

  // Plaintext → reuse the read-only renderer for type-aware display.
  if (value.kind === 'plaintext') {
    if (field) {
      return <FieldRenderer field={field} value={value.value} readOnly />;
    }
    return (
      <FallbackField label={label} body={String(value.value ?? '—')} />
    );
  }

  if (value.kind === 'media' || value.kind === 'encrypted-media') {
    const note =
      value.kind === 'encrypted-media'
        ? 'encrypted media (Seal) — open to fetch ciphertext'
        : `${value.mime} · ${value.bytes} bytes`;
    return (
      <FallbackField
        label={label}
        body={`${value.kind === 'encrypted-media' ? '🔒 ' : '📎 '}${value.blobId}`}
        sub={note}
      />
    );
  }

  // value.kind === 'encrypted'
  const { mode, b64 } = value.envelope;

  if (mode === 'placeholder') {
    // The placeholder base64-wraps PLAINTEXT — decode and label loudly.
    let decoded = '(unreadable)';
    try {
      decoded = new TextDecoder().decode(fromBase64(b64));
    } catch {
      /* keep fallback */
    }
    return (
      <View style={styles.privateField}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <View style={styles.placeholderTag}>
          <Text style={styles.placeholderTagText}>
            ⚠ PLACEHOLDER — not encrypted (submitter had no WebCrypto)
          </Text>
        </View>
        <Text style={styles.fieldBody}>{decoded}</Text>
      </View>
    );
  }

  // mode === 'seal'
  if (decrypted?.text != null) {
    return (
      <View style={styles.privateField}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <View style={styles.unlockedTag}>
          <Text style={styles.unlockedTagText}>🔓 decrypted (Seal)</Text>
        </View>
        <Text style={styles.fieldBody}>{decrypted.text}</Text>
      </View>
    );
  }

  return (
    <View style={styles.privateField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.sealedTag}>
        <Text style={styles.sealedTagText}>
          🔒 Seal-encrypted
          {decrypted?.error ? ` · ${decrypted.error}` : ' · tap “Decrypt” above'}
        </Text>
      </View>
    </View>
  );
}

function FallbackField({
  label,
  body,
  sub,
}: {
  label: string;
  body: string;
  sub?: string;
}) {
  return (
    <View style={styles.privateField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldBody}>{body}</Text>
      {sub ? <Text style={styles.fieldSub}>{sub}</Text> : null}
    </View>
  );
}

function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: { padding: 16, paddingBottom: 40, gap: 12 },

  title: { color: C.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: C.muted, fontSize: 13.5, marginTop: -4 },

  banner: { borderRadius: 12, padding: 12, borderWidth: 1 },
  bannerWarn: {
    backgroundColor: 'rgba(251,191,36,0.1)',
    borderColor: 'rgba(251,191,36,0.4)',
  },
  bannerWarnText: { color: C.warn, fontSize: 12.5, lineHeight: 18 },
  bannerErr: {
    backgroundColor: 'rgba(248,113,113,0.1)',
    borderColor: 'rgba(248,113,113,0.4)',
  },
  bannerErrText: { color: C.danger, fontSize: 12.5, lineHeight: 18 },

  decryptBtn: {
    backgroundColor: C.primary,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  btnBusy: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  decryptText: { color: '#06291F', fontSize: 14.5, fontWeight: '800' },

  empty: { alignItems: 'center', gap: 8, paddingTop: 48 },
  emptyTitle: { color: C.text, fontSize: 16, fontWeight: '700' },
  emptyBody: { color: C.muted, fontSize: 13.5, textAlign: 'center' },

  card: {
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cardWhen: { color: C.text, fontSize: 14, fontWeight: '700' },
  cardWho: { color: C.muted, fontSize: 12, fontFamily: 'Courier' },
  pills: { flexDirection: 'row', gap: 6 },
  statusPill: {
    backgroundColor: C.surface2,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusText: { color: C.muted, fontSize: 10.5, fontWeight: '800' },
  prioPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  prioText: { fontSize: 10.5, fontWeight: '800' },

  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  tag: {
    backgroundColor: C.surface2,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tagText: { color: C.accent, fontSize: 11.5 },

  adminBar: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: C.border,
    gap: 6,
  },
  adminLabel: {
    color: C.muted,
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  adminRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  adminPill: {
    backgroundColor: C.surface2,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    minHeight: 28,
    justifyContent: 'center',
  },
  adminPillActive: { borderColor: C.primary, backgroundColor: C.surface2 },
  adminPillFaded: { opacity: 0.5 },
  adminPillText: { color: C.muted, fontSize: 11, fontWeight: '700' },
  adminPillTextActive: { color: C.primary, fontWeight: '800' },

  tagAddRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  tagInput: {
    flex: 1,
    backgroundColor: C.surface2,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: C.text,
    fontSize: 13.5,
  },
  tagAddBtn: {
    backgroundColor: C.primary,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagAddBtnText: { color: '#06291F', fontSize: 13.5, fontWeight: '800' },
  adminError: { color: C.danger, fontSize: 12, marginTop: 2 },

  divider: {
    height: 1,
    backgroundColor: C.border,
    marginVertical: 14,
  },

  privateField: { marginBottom: 16, gap: 4 },
  fieldLabel: { color: C.text, fontSize: 14, fontWeight: '700' },
  fieldBody: { color: C.text, fontSize: 15 },
  fieldSub: { color: C.muted, fontSize: 12 },
  fieldError: { color: C.danger, fontSize: 13 },

  placeholderTag: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(251,191,36,0.12)',
    borderColor: 'rgba(251,191,36,0.45)',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  placeholderTagText: { color: C.warn, fontSize: 11, fontWeight: '700' },
  sealedTag: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(96,165,250,0.12)',
    borderColor: 'rgba(96,165,250,0.4)',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  sealedTagText: { color: C.accent, fontSize: 11.5, fontWeight: '700' },
  unlockedTag: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(52,211,153,0.12)',
    borderColor: 'rgba(52,211,153,0.45)',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  unlockedTagText: { color: C.ok, fontSize: 11, fontWeight: '700' },
});
