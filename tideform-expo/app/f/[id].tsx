/**
 * app/f/[id].tsx — Flows C + D: view a form, fill it, submit it.
 *
 * C (view): fetchForm(id) → fetchFormSchema(schemaBlobId) → render every field by
 *           type via <FieldRenderer> (all on-device, public reads).
 * D (submit): assemble the Submission JSON (Seal-encrypt private fields best-effort)
 *           → uploadJson() to the SPONSORED Walrus route → get blob_id →
 *           txSubmit({ formId, blobId }) → signAndExecuteCustodial(tx, address)
 *           → show the tx digest + Walrus receipt. ZERO gas, ZERO popups (§9.D).
 *
 * The only two steps that leave the device are the two that need a server-held
 * secret: the sponsored Walrus upload and the custodial sign+sponsor (the Walrus
 * key, the custodial key, the gas sponsor). Everything else is local.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  type Field,
  type FieldValue,
  type FormObject,
  type FormSchema,
  type Submission,
  fetchForm,
  fetchFormSchema,
  isSealAvailable,
  sealEncryptText,
  signAndExecuteLocal,
  txSubmit,
  uploadJson,
  useAuth,
} from '@/lib';
import { FieldRenderer } from '@/components/field-renderer';
import { Receipt } from '@/components/receipt';

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

type Phase = 'loading' | 'ready' | 'submitting' | 'done' | 'error';

interface ReceiptData {
  digest: string;
  blobId: string;
  walCost?: number;
  endEpoch?: number;
}

export default function FormScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const formId = String(id ?? '');
  const router = useRouter();
  const { user } = useAuth();

  const [form, setForm] = useState<FormObject | null>(null);
  const [schema, setSchema] = useState<FormSchema | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState<string>();
  const [submitError, setSubmitError] = useState<string>();
  const [progress, setProgress] = useState<string>('');
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);

  const fields: Field[] = useMemo(
    () => (schema ? schema.sections.flatMap((s) => s.fields) : []),
    [schema],
  );
  const hasPrivate = useMemo(() => fields.some((f) => f.private), [fields]);

  const load = useCallback(async () => {
    setPhase('loading');
    setLoadError(undefined);
    try {
      const f = await fetchForm(formId);
      if (!f) throw new Error('Form not found on-chain.');
      const s = await fetchFormSchema(f.schemaBlobId);
      const initial: Record<string, unknown> = {};
      for (const field of s.sections.flatMap((sec) => sec.fields)) {
        initial[field.id] = defaultFor(field);
      }
      setForm(f);
      setSchema(s);
      setValues(initial);
      setPhase('ready');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [formId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setValue = useCallback((fieldId: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [fieldId]: v }));
    setErrors((prev) => {
      if (!prev[fieldId]) return prev;
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
  }, []);

  function validate(): boolean {
    const next: Record<string, string> = {};
    for (const field of fields) {
      if (!field.required) continue;
      if (isEmpty(values[field.id])) {
        next[field.id] = 'Required';
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(): Promise<void> {
    if (!form || !schema || !user?.address) return;
    if (form.status !== 0) {
      setSubmitError('This form is not open for submissions.');
      return;
    }
    if (!validate()) return;

    setPhase('submitting');
    setSubmitError(undefined);
    try {
      // 1. Assemble the Submission.fields map (encrypt private fields).
      setProgress('Encrypting + packaging…');
      const fieldValues: Record<string, FieldValue> = {};
      for (const field of fields) {
        const raw = values[field.id];
        if (isEmpty(raw)) continue; // omit empty optional fields
        if (field.private) {
          // Seal best-effort: real encryption when WebCrypto is present, else a
          // clearly-labeled placeholder (lib/seal.ts). Never claimed as real.
          fieldValues[field.id] = await sealEncryptText({
            formId,
            fieldId: field.id,
            text: stringify(raw),
          });
        } else {
          fieldValues[field.id] = { kind: 'plaintext', value: raw };
        }
      }

      const submission: Submission = {
        formId,
        formVersion: schema.formVersion,
        submittedAt: new Date().toISOString(),
        submitter: user.address,
        fields: fieldValues,
      };

      // 2. Upload payload to Walrus via the SPONSORED backend route.
      setProgress('Uploading to Walrus (sponsored)…');
      const upload = await uploadJson(submission, { owner: user.address });
      if (!upload.blobId) throw new Error('Walrus upload returned no blob_id.');

      // 3. Build submission::submit PTB. The on-device key signs as sender; the
      //    backend sponsor pays gas + co-signs. Gasless, non-custodial.
      setProgress('Submitting on-chain (gasless)…');
      const tx = txSubmit({ formId, blobId: upload.blobId });
      const res = await signAndExecuteLocal(tx);

      setReceipt({
        digest: res.digest,
        blobId: upload.blobId,
        walCost: upload.walCost,
        endEpoch: upload.endEpoch,
      });
      setPhase('done');
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
      setPhase('submitting'); // stay on the form so the user can retry
    } finally {
      setProgress('');
    }
  }

  // ── Render states ───────────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={C.primary} size="large" />
      </View>
    );
  }

  if (phase === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errTitle}>Couldn't load this form</Text>
        <Text style={styles.errBody}>{loadError}</Text>
        <Pressable style={styles.primaryBtn} onPress={() => void load()}>
          <Text style={styles.primaryBtnText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'done' && receipt) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.doneWrap}>
          <Receipt
            txDigest={receipt.digest}
            blobId={receipt.blobId}
            walCost={receipt.walCost}
            endEpoch={receipt.endEpoch}
          />
          <Pressable
            style={styles.primaryBtn}
            onPress={() => {
              // Reset to a fresh blank form for another submission.
              const blank: Record<string, unknown> = {};
              for (const field of fields) blank[field.id] = defaultFor(field);
              setValues(blank);
              setReceipt(null);
              setPhase('ready');
            }}
          >
            <Text style={styles.primaryBtnText}>Submit another</Text>
          </Pressable>
          <Pressable style={styles.ghostBtn} onPress={() => router.back()}>
            <Text style={styles.ghostBtnText}>Back to my forms</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ready | submitting
  const submitting = phase === 'submitting' && !!progress;
  const closed = form ? form.status !== 0 : false;

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
          <Text style={styles.title}>{schema?.title}</Text>
          {schema?.description ? (
            <Text style={styles.description}>{schema.description}</Text>
          ) : null}

          {closed ? (
            <View style={[styles.banner, styles.bannerWarn]}>
              <Text style={styles.bannerWarnText}>
                This form is {form?.status === 1 ? 'closed' : 'archived'} — new
                submissions are disabled.
              </Text>
            </View>
          ) : null}

          {hasPrivate ? (
            <View style={[styles.banner, styles.bannerInfo]}>
              <Text style={styles.bannerInfoText}>
                🔒 Private fields use Seal on this device:{' '}
                {isSealAvailable()
                  ? 'encryption is active.'
                  : 'no WebCrypto here, so they are stored as a labeled placeholder (not encrypted).'}
              </Text>
            </View>
          ) : null}

          {schema?.sections.map((section) => (
            <View key={section.id} style={styles.section}>
              {section.title ? (
                <Text style={styles.sectionTitle}>{section.title}</Text>
              ) : null}
              {section.fields.map((field) => (
                <FieldRenderer
                  key={field.id}
                  field={field}
                  value={values[field.id]}
                  onChange={(v) => setValue(field.id, v)}
                  error={errors[field.id]}
                />
              ))}
            </View>
          ))}

          {submitError ? (
            <Text style={styles.submitError}>{submitError}</Text>
          ) : null}

          <Pressable
            style={[
              styles.primaryBtn,
              (submitting || closed) && styles.btnDisabled,
            ]}
            onPress={() => void onSubmit()}
            disabled={submitting || closed}
          >
            {submitting ? (
              <View style={styles.btnBusy}>
                <ActivityIndicator color="#06291F" />
                <Text style={styles.primaryBtnText}>{progress}</Text>
              </View>
            ) : (
              <Text style={styles.primaryBtnText}>Submit · gasless</Text>
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

// ── Value helpers ──────────────────────────────────────────────────────────────

function defaultFor(field: Field): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue;
  switch (field.type) {
    case 'multi_select':
      return [];
    case 'checkbox':
      return false;
    case 'rating':
    case 'number':
      return '';
    default:
      return '';
  }
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'boolean') return v === false;
  if (typeof v === 'number') return false;
  return false;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  scroll: { padding: 18, paddingBottom: 48 },
  doneWrap: { padding: 18, gap: 14 },

  title: { color: C.text, fontSize: 24, fontWeight: '800', marginBottom: 6 },
  description: { color: C.muted, fontSize: 14.5, lineHeight: 21, marginBottom: 14 },

  banner: { borderRadius: 12, padding: 12, borderWidth: 1, marginBottom: 14 },
  bannerWarn: {
    backgroundColor: 'rgba(251,191,36,0.1)',
    borderColor: 'rgba(251,191,36,0.4)',
  },
  bannerWarnText: { color: C.warn, fontSize: 13, lineHeight: 18 },
  bannerInfo: {
    backgroundColor: 'rgba(96,165,250,0.1)',
    borderColor: 'rgba(96,165,250,0.35)',
  },
  bannerInfoText: { color: C.accent, fontSize: 12.5, lineHeight: 18 },

  section: { marginBottom: 8 },
  sectionTitle: {
    color: C.text,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 12,
    opacity: 0.8,
  },

  submitError: { color: C.danger, fontSize: 13.5, marginBottom: 12 },

  primaryBtn: {
    backgroundColor: C.primary,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 6,
  },
  btnDisabled: { opacity: 0.5 },
  btnBusy: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  primaryBtnText: { color: '#06291F', fontSize: 16, fontWeight: '800' },
  ghostBtn: { alignItems: 'center', paddingVertical: 12 },
  ghostBtnText: { color: C.muted, fontSize: 14, fontWeight: '600' },

  footerNote: {
    color: C.muted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 17,
  },

  errTitle: { color: C.text, fontSize: 17, fontWeight: '700' },
  errBody: { color: C.muted, fontSize: 14, textAlign: 'center' },
});
