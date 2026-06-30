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
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

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
import {
  Banner,
  Card,
  GradientButton,
  OutlineButton,
  Screen,
  SectionLabel,
} from '@/components/ui';
import { colors, space } from '@/lib/theme';

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
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (phase === 'error') {
    return (
      <Screen edges={['bottom']}>
        <View style={styles.center}>
          <Card style={styles.errCard}>
            <Text style={styles.errTitle}>Couldn't load this form</Text>
            <Text style={styles.errBody}>{loadError}</Text>
            <GradientButton label="Retry" onPress={() => void load()} />
          </Card>
        </View>
      </Screen>
    );
  }

  if (phase === 'done' && receipt) {
    return (
      <Screen edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.doneWrap}>
          <Receipt
            txDigest={receipt.digest}
            blobId={receipt.blobId}
            walCost={receipt.walCost}
            endEpoch={receipt.endEpoch}
          />
          <GradientButton
            label="Submit another"
            onPress={() => {
              // Reset to a fresh blank form for another submission.
              const blank: Record<string, unknown> = {};
              for (const field of fields) blank[field.id] = defaultFor(field);
              setValues(blank);
              setReceipt(null);
              setPhase('ready');
            }}
          />
          <OutlineButton label="Back to my forms" onPress={() => router.back()} />
        </ScrollView>
      </Screen>
    );
  }

  // ready | submitting
  const submitting = phase === 'submitting' && !!progress;
  const closed = form ? form.status !== 0 : false;

  return (
    <Screen edges={['bottom']}>
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
            <View style={styles.bannerWrap}>
              <Banner tone="warning">
                This form is {form?.status === 1 ? 'closed' : 'archived'} — new
                submissions are disabled.
              </Banner>
            </View>
          ) : null}

          {hasPrivate ? (
            <View style={styles.bannerWrap}>
              <Banner tone="info">
                🔒 Private fields use Seal on this device:{' '}
                {isSealAvailable()
                  ? 'encryption is active.'
                  : 'no WebCrypto here, so they are stored as a labeled placeholder (not encrypted).'}
              </Banner>
            </View>
          ) : null}

          <Card style={styles.formCard}>
            {schema?.sections.map((section, idx) => (
              <View
                key={section.id}
                style={idx > 0 ? styles.sectionGap : undefined}
              >
                {section.title ? (
                  <View style={styles.sectionHeading}>
                    <SectionLabel>{section.title}</SectionLabel>
                  </View>
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
          </Card>

          {submitError ? (
            <Text style={styles.submitError}>{submitError}</Text>
          ) : null}

          <GradientButton
            label="Submit · gasless"
            onPress={() => void onSubmit()}
            loading={submitting}
            loadingLabel={progress}
            disabled={closed}
          />

          <Text style={styles.footerNote}>
            No gas prompt, no wallet popup — your on-device key signs and the
            sponsor wallet pays the gas.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
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
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    padding: space.xl,
  },
  scroll: { padding: space.lg, paddingBottom: 48, gap: space.md },
  doneWrap: { padding: space.lg, gap: space.md },

  title: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: 2 },
  description: {
    color: colors.muted,
    fontSize: 14.5,
    lineHeight: 21,
  },

  bannerWrap: { marginTop: 2 },

  formCard: { gap: space.sm, marginTop: 2 },
  sectionGap: { marginTop: space.lg },
  sectionHeading: { marginBottom: space.sm },

  submitError: { color: colors.danger, fontSize: 13.5, fontWeight: '600' },

  footerNote: {
    color: colors.subtle,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 2,
    lineHeight: 17,
  },

  errCard: { gap: space.md, alignSelf: 'stretch' },
  errTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  errBody: { color: colors.muted, fontSize: 14, lineHeight: 20 },
});
