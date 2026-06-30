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
import { colors, mono, radius, shortAddr } from '@/lib/theme';
import {
  Banner,
  Card,
  GradientButton,
  Pill,
  Screen,
  SectionLabel,
} from '@/components/ui';

const SUB_STATUS = ['NEW', 'IN PROGRESS', 'RESOLVED', 'SPAM'];
const PRIORITY = ['LOW', 'MED', 'HIGH', 'URGENT'];
const PRIORITY_COLOR = [colors.subtle, colors.primary, colors.warning, colors.danger];

type PillTone = 'muted' | 'primary' | 'success' | 'warning' | 'danger' | 'teal';
const STATUS_TONE: PillTone[] = ['primary', 'warning', 'success', 'danger'];
const PRIORITY_TONE: PillTone[] = ['muted', 'primary', 'warning', 'danger'];

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
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <Screen edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={colors.primary}
          />
        }
      >
        <Text style={styles.title}>{schema?.title ?? 'Inbox'}</Text>
        <Text style={styles.subtitle}>
          {items.length} {items.length === 1 ? 'submission' : 'submissions'}
          {form ? ` · ${form.admins.length + 1} admin(s)` : ''}
        </Text>

        {!isAdmin ? (
          <Banner tone="warning">
            You are not an admin of this form. Public fields are visible, but
            private (Seal) fields can only be decrypted by the form's admins.
          </Banner>
        ) : null}

        {error ? <Banner tone="danger">{error}</Banner> : null}

        {hasSealCiphertext && isAdmin ? (
          <GradientButton
            label={`🔓 Decrypt private fields ${isSealAvailable() ? '' : '(unavailable)'}`}
            onPress={() => void decryptAll()}
            loading={decrypting}
            loadingLabel="Decrypting…"
            disabled={decrypting}
          />
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
    </Screen>
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
    <Card>
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
          <Pill
            label={SUB_STATUS[obj.status] ?? `?${obj.status}`}
            tone={STATUS_TONE[obj.status] ?? 'muted'}
          />
          <Pill
            label={PRIORITY[obj.priority] ?? '?'}
            tone={PRIORITY_TONE[obj.priority] ?? 'muted'}
          />
        </View>
      </View>

      {obj.tags.length > 0 ? (
        <View style={styles.tagRow}>
          {obj.tags.map((t) => (
            <Pill key={t} label={`#${t}`} tone="teal" />
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
    </Card>
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
      <SectionLabel>Status</SectionLabel>
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
                <ActivityIndicator size="small" color={colors.primary} />
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

      <SectionLabel>Priority</SectionLabel>
      <View style={styles.adminRow}>
        {PRIORITY.map((label, i) => {
          const active = obj.priority === i;
          const color = PRIORITY_COLOR[i] ?? colors.subtle;
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
                active && { borderColor: color, backgroundColor: colors.surfaceLift },
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

      <SectionLabel>Add tag</SectionLabel>
      <View style={styles.tagAddRow}>
        <TextInput
          value={tagText}
          onChangeText={setTagText}
          placeholder="e.g. follow-up"
          placeholderTextColor={colors.subtle}
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
            <ActivityIndicator size="small" color={colors.white} />
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
        <Pill
          tone="warning"
          label="⚠ PLACEHOLDER — not encrypted (submitter had no WebCrypto)"
        />
        <Text style={styles.fieldBody}>{decoded}</Text>
      </View>
    );
  }

  // mode === 'seal'
  if (decrypted?.text != null) {
    return (
      <View style={styles.privateField}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <Pill tone="success" label="🔓 decrypted (Seal)" />
        <Text style={styles.fieldBody}>{decrypted.text}</Text>
      </View>
    );
  }

  return (
    <View style={styles.privateField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Pill
        tone="primary"
        label={`🔒 Seal-encrypted${
          decrypted?.error ? ` · ${decrypted.error}` : ' · tap “Decrypt” above'
        }`}
      />
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

const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: { padding: 16, paddingBottom: 40, gap: 12 },

  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.muted, fontSize: 13.5, marginTop: -4 },

  empty: { alignItems: 'center', gap: 8, paddingTop: 48 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  emptyBody: { color: colors.muted, fontSize: 13.5, textAlign: 'center' },

  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cardWhen: { color: colors.text, fontSize: 14, fontWeight: '700' },
  cardWho: { color: colors.muted, fontSize: 12, fontFamily: mono },
  pills: { flexDirection: 'row', gap: 6 },

  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },

  adminBar: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 6,
  },
  adminRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  adminPill: {
    backgroundColor: colors.surfaceLift,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    minHeight: 28,
    justifyContent: 'center',
  },
  adminPillActive: { borderColor: colors.primary, backgroundColor: colors.surfaceLift },
  adminPillFaded: { opacity: 0.5 },
  adminPillText: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  adminPillTextActive: { color: colors.primary, fontWeight: '800' },

  tagAddRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  tagInput: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.input,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 13.5,
  },
  tagAddBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.input,
    paddingHorizontal: 16,
    paddingVertical: 11,
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  tagAddBtnText: { color: colors.white, fontSize: 13.5, fontWeight: '800' },
  adminError: { color: colors.danger, fontSize: 12, marginTop: 2 },

  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 14,
  },

  privateField: { marginBottom: 16, gap: 4 },
  fieldLabel: { color: colors.text, fontSize: 14, fontWeight: '700' },
  fieldBody: { color: colors.text, fontSize: 15 },
  fieldSub: { color: colors.muted, fontSize: 12 },
  fieldError: { color: colors.danger, fontSize: 13 },
});
