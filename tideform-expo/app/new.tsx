/**
 * app/new.tsx — Flow A: build a form, then create it on-chain (gasless).
 *
 * The tidalform website's core feature, ported to the phone:
 *   1. Edit a FormSchema in-app (title, settings, a list of typed fields).
 *   2. uploadJson(schema, { owner }) → SPONSORED Walrus upload → schema blob id.
 *   3. txCreateForm({ schemaBlobId, requireWallet, onePerWallet }) → a PTB.
 *   4. signAndExecuteLocal(tx) → on-device key signs as sender, backend sponsor
 *      pays gas + co-signs. Gasless, non-custodial, no popup. Returns the new
 *      Form object id (res.createdFormId).
 *
 * Everything here is local except the two server-secret steps (the sponsored
 * Walrus upload and the sponsored sign) — same split as app/f/[id].tsx.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  type Field,
  type FieldType,
  type FormSchema,
  signAndExecuteLocal,
  txCreateForm,
  uploadJson,
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

// The non-media field types, in builder order (media types are upload-only and
// can't be authored from the phone here).
const FIELD_TYPES: FieldType[] = [
  'short_text',
  'long_text',
  'rich_text',
  'email',
  'url',
  'number',
  'date',
  'wallet',
  'checkbox',
  'rating',
  'dropdown',
  'multi_select',
];

const TYPE_LABEL: Record<string, string> = {
  short_text: 'Short text',
  long_text: 'Long text',
  rich_text: 'Rich text',
  email: 'Email',
  url: 'URL',
  number: 'Number',
  date: 'Date',
  wallet: 'Wallet',
  checkbox: 'Checkbox',
  rating: 'Rating',
  dropdown: 'Dropdown',
  multi_select: 'Multi-select',
};

const DEFAULT_SUCCESS = 'Thanks for your submission.';

type Phase = 'edit' | 'creating' | 'done';

// Editor-only models (kept separate from the exported FormSchema). Option rows
// carry a stable `id` for React keys; the schema's FieldOption is {label,value}.
interface EditorOption {
  id: string;
  label: string;
}
interface EditorField {
  id: string;
  type: FieldType;
  label: string;
  required: boolean;
  private: boolean;
  options: EditorOption[]; // only used by dropdown / multi_select
  scale: string; // only used by rating (text so the input can be empty mid-edit)
}

let _seq = 0;
function uid(prefix = 'f'): string {
  return `${prefix}${Date.now()}${_seq++}`;
}

function isOptionType(t: FieldType): boolean {
  return t === 'dropdown' || t === 'multi_select';
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'option'
  );
}

function blankField(type: FieldType = 'short_text'): EditorField {
  return {
    id: uid(),
    type,
    label: '',
    required: false,
    private: false,
    options: [],
    scale: '5',
  };
}

export default function NewFormScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const address = user?.address;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [successMessage, setSuccessMessage] = useState(DEFAULT_SUCCESS);
  const [requireWallet, setRequireWallet] = useState(false);
  const [onePerWallet, setOnePerWallet] = useState(false);
  const [fields, setFields] = useState<EditorField[]>([blankField()]);

  const [phase, setPhase] = useState<Phase>('edit');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [createdFormId, setCreatedFormId] = useState<string | undefined>();

  // ── Field mutations ───────────────────────────────────────────────────────
  function updateField(id: string, patch: Partial<EditorField>) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }
  function addField() {
    setFields((prev) => [...prev, blankField()]);
  }
  function removeField(id: string) {
    setFields((prev) => (prev.length <= 1 ? prev : prev.filter((f) => f.id !== id)));
  }
  function moveField(index: number, dir: -1 | 1) {
    setFields((prev) => {
      const j = index + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }
  function changeType(f: EditorField, type: FieldType) {
    // Seed two empty option rows the first time a choice type is selected.
    const options =
      isOptionType(type) && f.options.length < 2
        ? [{ id: uid('o'), label: '' }, { id: uid('o'), label: '' }]
        : f.options;
    updateField(f.id, { type, options });
  }
  function addOption(fieldId: string) {
    setFields((prev) =>
      prev.map((f) =>
        f.id === fieldId
          ? { ...f, options: [...f.options, { id: uid('o'), label: '' }] }
          : f,
      ),
    );
  }
  function updateOption(fieldId: string, optId: string, label: string) {
    setFields((prev) =>
      prev.map((f) =>
        f.id === fieldId
          ? {
              ...f,
              options: f.options.map((o) => (o.id === optId ? { ...o, label } : o)),
            }
          : f,
      ),
    );
  }
  function removeOption(fieldId: string, optId: string) {
    setFields((prev) =>
      prev.map((f) =>
        f.id === fieldId
          ? { ...f, options: f.options.filter((o) => o.id !== optId) }
          : f,
      ),
    );
  }

  // ── Validation ────────────────────────────────────────────────────────────
  function validateAll(): string | null {
    if (!title.trim()) return 'Add a form title.';
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f.label.trim()) return `Field ${i + 1} needs a label.`;
      if (isOptionType(f.type)) {
        const valid = f.options.filter((o) => o.label.trim().length > 0);
        if (valid.length < 2) {
          return `"${f.label.trim()}" needs at least 2 options.`;
        }
      }
    }
    return null;
  }

  // ── Assemble the exported FormSchema from the editor state ─────────────────
  function assembleSchema(): FormSchema {
    const outFields: Field[] = fields.map((f) => {
      const field: Field = {
        id: f.id,
        type: f.type,
        label: f.label.trim(),
        required: f.required,
        private: f.private,
      };
      if (isOptionType(f.type)) {
        field.options = f.options
          .filter((o) => o.label.trim().length > 0)
          .map((o) => ({ label: o.label.trim(), value: slugify(o.label) }));
      }
      if (f.type === 'rating') {
        const n = Math.max(2, Math.min(10, parseInt(f.scale, 10) || 5));
        field.validation = { maxRating: n, scale: n };
      }
      return field;
    });

    return {
      version: 1,
      formVersion: 1,
      title: title.trim(),
      description: description.trim(),
      theme: { primary: '#0ea5e9', mode: 'system' },
      settings: {
        requireWallet,
        onePerWallet,
        captcha: false,
        successMessage: successMessage.trim() || DEFAULT_SUCCESS,
        style: 'compact',
      },
      sections: [{ id: 's1', fields: outFields }],
    };
  }

  // ── Create flow ───────────────────────────────────────────────────────────
  async function onCreate(): Promise<void> {
    setError(undefined);
    if (!address) {
      setError('No device wallet yet — sign in before creating a form.');
      return;
    }
    const problem = validateAll();
    if (problem) {
      setError(problem);
      return;
    }

    setPhase('creating');
    try {
      // 1. Build the schema document.
      setProgress('Packaging schema…');
      const schema = assembleSchema();

      // 2. Upload it to Walrus via the SPONSORED backend route.
      setProgress('Uploading schema to Walrus (sponsored)…');
      const { blobId } = await uploadJson(schema, { owner: address });
      if (!blobId) throw new Error('Walrus upload returned no blob id.');

      // 3. Build the form::create PTB.
      setProgress('Creating form on-chain (gasless)…');
      const tx = txCreateForm({ schemaBlobId: blobId, requireWallet, onePerWallet });

      // 4. On-device key signs as sender; sponsor pays gas + co-signs.
      const res = await signAndExecuteLocal(tx);
      if (!res.createdFormId) {
        throw new Error('Form created, but no Form object id was returned.');
      }

      setCreatedFormId(res.createdFormId);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('edit'); // stay on the editor so the user can retry
    } finally {
      setProgress('');
    }
  }

  // ── Done state ────────────────────────────────────────────────────────────
  if (phase === 'done' && createdFormId) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.doneWrap}>
          <View style={styles.card}>
            <Text style={styles.doneTitle}>Form created 🎉</Text>
            <Text style={styles.doneNote}>
              Your form is live on-chain. Share its link or open the inbox to
              watch submissions land.
            </Text>
            <Text style={styles.fieldLabel}>Form ID</Text>
            <Text style={styles.mono} selectable>
              {createdFormId}
            </Text>
          </View>

          <Pressable
            style={styles.primaryBtn}
            onPress={() => router.push(`/f/${createdFormId}`)}
          >
            <Text style={styles.primaryBtnText}>Fill it</Text>
          </Pressable>
          <Pressable
            style={styles.secondaryBtn}
            onPress={() => router.push(`/inbox/${createdFormId}`)}
          >
            <Text style={styles.secondaryBtnText}>View inbox</Text>
          </Pressable>
          <Pressable style={styles.ghostBtn} onPress={() => router.replace('/')}>
            <Text style={styles.ghostBtnText}>Back to My Forms</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Editor state ──────────────────────────────────────────────────────────
  const busy = phase === 'creating';

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.screenTitle}>New form</Text>
          <Text style={styles.screenSub}>
            Build a form, then create it on-chain — gasless, no popups.
          </Text>

          {!address ? (
            <View style={[styles.banner, styles.bannerWarn]}>
              <Text style={styles.bannerWarnText}>
                No device wallet detected — sign in first to create a form.
              </Text>
            </View>
          ) : null}

          {/* ── Basics ───────────────────────────────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Basics</Text>

            <Text style={styles.fieldLabel}>Title *</Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Bug report"
              placeholderTextColor={C.muted}
            />

            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={description}
              onChangeText={setDescription}
              placeholder="What is this form for? (optional)"
              placeholderTextColor={C.muted}
              multiline
            />

            <Text style={styles.fieldLabel}>Success message</Text>
            <TextInput
              style={styles.input}
              value={successMessage}
              onChangeText={setSuccessMessage}
              placeholder={DEFAULT_SUCCESS}
              placeholderTextColor={C.muted}
            />
          </View>

          {/* ── Settings ─────────────────────────────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Settings</Text>

            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={styles.switchLabel}>Require wallet</Text>
                <Text style={styles.switchHelp}>
                  Submitters must be signed in with a wallet.
                </Text>
              </View>
              <Switch
                value={requireWallet}
                onValueChange={setRequireWallet}
                trackColor={{ false: C.border, true: C.primary }}
                thumbColor="#E7EEF8"
              />
            </View>

            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={styles.switchLabel}>One per wallet</Text>
                <Text style={styles.switchHelp}>
                  Each wallet can submit only once.
                </Text>
              </View>
              <Switch
                value={onePerWallet}
                onValueChange={setOnePerWallet}
                trackColor={{ false: C.border, true: C.primary }}
                thumbColor="#E7EEF8"
              />
            </View>
          </View>

          {/* ── Fields ───────────────────────────────────────────────────── */}
          <Text style={styles.sectionLabel}>Fields</Text>

          {fields.map((f, i) => (
            <View key={f.id} style={styles.card}>
              <View style={styles.fieldHeader}>
                <Text style={styles.fieldIndex}>Field {i + 1}</Text>
                <View style={styles.fieldControls}>
                  <Pressable
                    style={[styles.ctrlBtn, i === 0 && styles.ctrlBtnDisabled]}
                    onPress={() => moveField(i, -1)}
                    disabled={i === 0}
                  >
                    <Text style={styles.ctrlBtnText}>↑</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.ctrlBtn,
                      i === fields.length - 1 && styles.ctrlBtnDisabled,
                    ]}
                    onPress={() => moveField(i, 1)}
                    disabled={i === fields.length - 1}
                  >
                    <Text style={styles.ctrlBtnText}>↓</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.ctrlBtn,
                      fields.length === 1 && styles.ctrlBtnDisabled,
                    ]}
                    onPress={() => removeField(f.id)}
                    disabled={fields.length === 1}
                  >
                    <Text style={[styles.ctrlBtnText, { color: C.danger }]}>
                      Remove
                    </Text>
                  </Pressable>
                </View>
              </View>

              <Text style={styles.fieldLabel}>Label *</Text>
              <TextInput
                style={styles.input}
                value={f.label}
                onChangeText={(v) => updateField(f.id, { label: v })}
                placeholder="Question / field label"
                placeholderTextColor={C.muted}
              />

              <Text style={styles.fieldLabel}>Type</Text>
              <View style={styles.chips}>
                {FIELD_TYPES.map((t) => {
                  const selected = f.type === t;
                  return (
                    <Pressable
                      key={t}
                      style={[styles.chip, selected && styles.chipSelected]}
                      onPress={() => changeType(f, t)}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          selected && styles.chipTextSelected,
                        ]}
                      >
                        {TYPE_LABEL[t]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {isOptionType(f.type) ? (
                <View style={styles.optionsBox}>
                  <Text style={styles.fieldLabel}>Options</Text>
                  {f.options.map((o, oi) => (
                    <View key={o.id} style={styles.optionRow}>
                      <TextInput
                        style={[styles.input, styles.optionInput]}
                        value={o.label}
                        onChangeText={(v) => updateOption(f.id, o.id, v)}
                        placeholder={`Option ${oi + 1}`}
                        placeholderTextColor={C.muted}
                      />
                      <Pressable
                        style={[
                          styles.ctrlBtn,
                          f.options.length <= 2 && styles.ctrlBtnDisabled,
                        ]}
                        onPress={() => removeOption(f.id, o.id)}
                        disabled={f.options.length <= 2}
                      >
                        <Text style={[styles.ctrlBtnText, { color: C.danger }]}>
                          ✕
                        </Text>
                      </Pressable>
                    </View>
                  ))}
                  <Pressable
                    style={styles.addOptionBtn}
                    onPress={() => addOption(f.id)}
                  >
                    <Text style={styles.addOptionText}>+ Add option</Text>
                  </Pressable>
                </View>
              ) : null}

              {f.type === 'rating' ? (
                <View>
                  <Text style={styles.fieldLabel}>Scale (2–10)</Text>
                  <TextInput
                    style={[styles.input, styles.scaleInput]}
                    value={f.scale}
                    onChangeText={(v) =>
                      updateField(f.id, { scale: v.replace(/[^0-9]/g, '') })
                    }
                    placeholder="5"
                    placeholderTextColor={C.muted}
                    keyboardType="number-pad"
                    maxLength={2}
                  />
                </View>
              ) : null}

              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>Required</Text>
                <Switch
                  value={f.required}
                  onValueChange={(v) => updateField(f.id, { required: v })}
                  trackColor={{ false: C.border, true: C.primary }}
                  thumbColor="#E7EEF8"
                />
              </View>
              <View style={styles.switchRow}>
                <View style={styles.switchText}>
                  <Text style={styles.switchLabel}>Private</Text>
                  <Text style={styles.switchHelp}>
                    Seal-encrypted before upload.
                  </Text>
                </View>
                <Switch
                  value={f.private}
                  onValueChange={(v) => updateField(f.id, { private: v })}
                  trackColor={{ false: C.border, true: C.primary }}
                  thumbColor="#E7EEF8"
                />
              </View>
            </View>
          ))}

          <Pressable style={styles.addFieldBtn} onPress={addField}>
            <Text style={styles.addFieldText}>+ Add field</Text>
          </Pressable>

          {error ? (
            <View style={[styles.banner, styles.bannerError]}>
              <Text style={styles.bannerErrorText}>{error}</Text>
            </View>
          ) : null}

          <Pressable
            style={[styles.primaryBtn, (busy || !address) && styles.btnDisabled]}
            onPress={() => void onCreate()}
            disabled={busy || !address}
          >
            {busy ? (
              <View style={styles.btnBusy}>
                <ActivityIndicator color="#06291F" />
                <Text style={styles.primaryBtnText}>{progress}</Text>
              </View>
            ) : (
              <Text style={styles.primaryBtnText}>Create form · gasless</Text>
            )}
          </Pressable>

          <Text style={styles.footerNote}>
            No gas prompt, no wallet popup — your on-device key signs and the
            sponsor wallet pays the gas.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 18, paddingBottom: 48, gap: 14 },
  doneWrap: { padding: 18, gap: 14 },

  screenTitle: { color: C.text, fontSize: 24, fontWeight: '800' },
  screenSub: { color: C.muted, fontSize: 14, lineHeight: 20, marginTop: -6 },

  sectionLabel: {
    color: C.text,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    opacity: 0.8,
    marginTop: 4,
  },

  card: {
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 8,
  },
  cardHeading: { color: C.text, fontSize: 16, fontWeight: '800', marginBottom: 2 },

  fieldLabel: {
    color: C.muted,
    fontSize: 12.5,
    fontWeight: '700',
    letterSpacing: 0.3,
    marginTop: 4,
  },
  input: {
    backgroundColor: C.surface2,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: C.text,
    fontSize: 15,
  },
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },
  scaleInput: { width: 84 },

  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 6,
  },
  switchText: { flex: 1 },
  switchLabel: { color: C.text, fontSize: 15, fontWeight: '700' },
  switchHelp: { color: C.muted, fontSize: 12.5, lineHeight: 17, marginTop: 2 },

  fieldHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fieldIndex: {
    color: C.accent,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  fieldControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ctrlBtn: {
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 34,
    alignItems: 'center',
  },
  ctrlBtnDisabled: { opacity: 0.4 },
  ctrlBtnText: { color: C.text, fontSize: 13, fontWeight: '700' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  chip: {
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: C.surface2,
  },
  chipSelected: {
    backgroundColor: 'rgba(45,212,191,0.14)',
    borderColor: 'rgba(45,212,191,0.5)',
  },
  chipText: { color: C.muted, fontSize: 13, fontWeight: '700' },
  chipTextSelected: { color: C.primary },

  optionsBox: { gap: 8, marginTop: 4 },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  optionInput: { flex: 1 },
  addOptionBtn: {
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 9,
    alignItems: 'center',
  },
  addOptionText: { color: C.accent, fontSize: 13.5, fontWeight: '700' },

  addFieldBtn: {
    borderColor: 'rgba(96,165,250,0.4)',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    backgroundColor: 'rgba(96,165,250,0.1)',
  },
  addFieldText: { color: C.accent, fontSize: 14.5, fontWeight: '800' },

  banner: { borderRadius: 12, padding: 12, borderWidth: 1 },
  bannerWarn: {
    backgroundColor: 'rgba(251,191,36,0.1)',
    borderColor: 'rgba(251,191,36,0.4)',
  },
  bannerWarnText: { color: C.warn, fontSize: 13, lineHeight: 18 },
  bannerError: {
    backgroundColor: 'rgba(248,113,113,0.1)',
    borderColor: 'rgba(248,113,113,0.45)',
  },
  bannerErrorText: { color: C.danger, fontSize: 13.5, lineHeight: 19 },

  primaryBtn: {
    backgroundColor: C.primary,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  btnDisabled: { opacity: 0.5 },
  btnBusy: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  primaryBtnText: { color: '#06291F', fontSize: 16, fontWeight: '800' },

  secondaryBtn: {
    borderColor: 'rgba(96,165,250,0.45)',
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    backgroundColor: 'rgba(96,165,250,0.1)',
  },
  secondaryBtnText: { color: C.accent, fontSize: 15.5, fontWeight: '800' },

  ghostBtn: { alignItems: 'center', paddingVertical: 12 },
  ghostBtnText: { color: C.muted, fontSize: 14, fontWeight: '600' },

  footerNote: {
    color: C.muted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 17,
  },

  doneTitle: { color: C.text, fontSize: 22, fontWeight: '800' },
  doneNote: { color: C.muted, fontSize: 14, lineHeight: 20 },
  mono: { color: C.text, fontSize: 13, fontFamily: 'Courier', marginTop: 2 },
});
