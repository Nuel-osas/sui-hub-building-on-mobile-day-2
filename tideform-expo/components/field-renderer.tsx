/**
 * components/field-renderer.tsx — renders ALL 14 Tideform field types.
 *
 * One component, two modes (source-of-truth §8):
 *   • input mode    (default)  → an interactive control bound to `value`/`onChange`.
 *   • read-only mode (`readOnly`) → a display of the submitted value; the admin
 *     inbox reuses this so a form renders the same way whether you're filling it
 *     or triaging a submission.
 *
 * The 14 types: short_text, long_text, rich_text, dropdown, multi_select,
 * checkbox, rating, screenshot, video, url, number, date, email, wallet.
 *
 * Dependency honesty: this stage ships only the base RN + Expo Router deps — no
 * native date-picker / image-picker. So `date` is a typed `YYYY-MM-DD` field and
 * the media types (`screenshot`/`video`) accept a Walrus blob ID or URL rather
 * than launching a gallery. Both are clearly labeled; wiring `expo-image-picker` /
 * `@react-native-community/datetimepicker` is left as a documented next step.
 */

import React from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { blobUrl, type Field } from '@/lib';

const C = {
  surface: '#0F1830',
  surfaceSel: 'rgba(45,212,191,0.14)',
  border: '#26324B',
  borderSel: '#2DD4BF',
  text: '#E7EEF8',
  muted: '#94A3B8',
  primary: '#2DD4BF',
  accent: '#60A5FA',
  warn: '#FBBF24',
  danger: '#F87171',
  star: '#FBBF24',
};

export interface FieldRendererProps {
  field: Field;
  value: unknown;
  /** Required in input mode; ignored when readOnly. */
  onChange?: (value: unknown) => void;
  /** Render the submitted value instead of an input (admin inbox). */
  readOnly?: boolean;
  /** Validation message to show under the control. */
  error?: string;
}

export function FieldRenderer({
  field,
  value,
  onChange,
  readOnly = false,
  error,
}: FieldRendererProps) {
  return (
    <View style={styles.wrap}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>
          {field.label}
          {field.required ? <Text style={styles.req}> *</Text> : null}
        </Text>
        {field.private ? (
          <View style={styles.privateBadge}>
            <Text style={styles.privateText}>🔒 private</Text>
          </View>
        ) : null}
      </View>

      {field.help ? <Text style={styles.help}>{field.help}</Text> : null}

      {readOnly ? (
        <DisplayValue field={field} value={value} />
      ) : (
        <InputControl
          field={field}
          value={value}
          onChange={onChange ?? (() => undefined)}
        />
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

// ── Input controls ────────────────────────────────────────────────────────────

function InputControl({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  switch (field.type) {
    case 'long_text':
    case 'rich_text':
      return (
        <TextInput
          style={[styles.input, styles.multiline]}
          value={asString(value)}
          onChangeText={onChange}
          placeholder={field.placeholder ?? ''}
          placeholderTextColor={C.muted}
          multiline
          numberOfLines={5}
          textAlignVertical="top"
        />
      );

    case 'number':
      return (
        <TextInput
          style={styles.input}
          value={asString(value)}
          onChangeText={onChange}
          placeholder={field.placeholder ?? '0'}
          placeholderTextColor={C.muted}
          keyboardType="numeric"
        />
      );

    case 'email':
      return (
        <TextInput
          style={styles.input}
          value={asString(value)}
          onChangeText={onChange}
          placeholder={field.placeholder ?? 'you@example.com'}
          placeholderTextColor={C.muted}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
        />
      );

    case 'url':
      return (
        <TextInput
          style={styles.input}
          value={asString(value)}
          onChangeText={onChange}
          placeholder={field.placeholder ?? 'https://…'}
          placeholderTextColor={C.muted}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
        />
      );

    case 'wallet':
      return (
        <TextInput
          style={[styles.input, styles.mono]}
          value={asString(value)}
          onChangeText={onChange}
          placeholder={field.placeholder ?? '0x…'}
          placeholderTextColor={C.muted}
          autoCapitalize="none"
          autoCorrect={false}
        />
      );

    case 'date':
      return (
        <>
          <TextInput
            style={styles.input}
            value={asString(value)}
            onChangeText={onChange}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.note}>
            Typed date (no native picker in this build).
          </Text>
        </>
      );

    case 'dropdown':
      return (
        <Dropdown
          options={field.options ?? []}
          selected={asString(value)}
          onSelect={onChange}
        />
      );

    case 'multi_select':
      return (
        <MultiSelect
          options={field.options ?? []}
          selected={asStringArray(value)}
          onToggle={(next) => onChange(next)}
        />
      );

    case 'checkbox':
      return (
        <View style={styles.checkboxRow}>
          <Switch
            value={Boolean(value)}
            onValueChange={onChange}
            trackColor={{ true: C.primary, false: C.border }}
            thumbColor="#FFFFFF"
          />
          <Text style={styles.checkboxLabel}>
            {Boolean(value) ? 'Yes' : 'No'}
          </Text>
        </View>
      );

    case 'rating':
      return (
        <Rating
          max={ratingMax(field)}
          value={Number(value) || 0}
          onRate={onChange}
        />
      );

    case 'screenshot':
    case 'video':
      return (
        <>
          <TextInput
            style={[styles.input, styles.mono]}
            value={asString(value)}
            onChangeText={onChange}
            placeholder={
              field.type === 'video'
                ? 'Walrus blob ID or video URL'
                : 'Walrus blob ID or image URL'
            }
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.note}>
            Paste an existing Walrus blob ID or a URL. Native file picking would
            add `expo-image-picker` / `expo-document-picker` (out of this stage's
            dep set).
          </Text>
        </>
      );

    case 'short_text':
    default:
      return (
        <TextInput
          style={styles.input}
          value={asString(value)}
          onChangeText={onChange}
          placeholder={field.placeholder ?? ''}
          placeholderTextColor={C.muted}
        />
      );
  }
}

function Dropdown({
  options,
  selected,
  onSelect,
}: {
  options: { label: string; value: string }[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  if (options.length === 0) {
    return <Text style={styles.note}>No options configured.</Text>;
  }
  return (
    <View style={styles.optionList}>
      {options.map((opt) => {
        const active = opt.value === selected;
        return (
          <Pressable
            key={opt.value}
            style={[styles.option, active && styles.optionActive]}
            onPress={() => onSelect(opt.value)}
          >
            <Text style={[styles.optionText, active && styles.optionTextActive]}>
              {opt.label}
            </Text>
            {active ? <Text style={styles.optionCheck}>✓</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function MultiSelect({
  options,
  selected,
  onToggle,
}: {
  options: { label: string; value: string }[];
  selected: string[];
  onToggle: (next: string[]) => void;
}) {
  if (options.length === 0) {
    return <Text style={styles.note}>No options configured.</Text>;
  }
  return (
    <View style={styles.chips}>
      {options.map((opt) => {
        const active = selected.includes(opt.value);
        return (
          <Pressable
            key={opt.value}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() =>
              onToggle(
                active
                  ? selected.filter((v) => v !== opt.value)
                  : [...selected, opt.value],
              )
            }
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>
              {active ? '✓ ' : ''}
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Rating({
  max,
  value,
  onRate,
}: {
  max: number;
  value: number;
  onRate: (n: number) => void;
}) {
  return (
    <View style={styles.starsRow}>
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <Pressable key={n} onPress={() => onRate(n)} hitSlop={6}>
          <Text style={[styles.star, n <= value && styles.starOn]}>★</Text>
        </Pressable>
      ))}
      <Text style={styles.ratingValue}>
        {value > 0 ? `${value}/${max}` : ''}
      </Text>
    </View>
  );
}

// ── Read-only display ─────────────────────────────────────────────────────────

function DisplayValue({ field, value }: { field: Field; value: unknown }) {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
    return <Text style={styles.displayEmpty}>—</Text>;
  }

  switch (field.type) {
    case 'dropdown': {
      const opt = (field.options ?? []).find((o) => o.value === value);
      return <Text style={styles.display}>{opt?.label ?? asString(value)}</Text>;
    }

    case 'multi_select': {
      const arr = asStringArray(value);
      const labels = arr.map(
        (v) => (field.options ?? []).find((o) => o.value === v)?.label ?? v,
      );
      return (
        <View style={styles.chips}>
          {labels.map((l) => (
            <View key={l} style={styles.tag}>
              <Text style={styles.tagText}>{l}</Text>
            </View>
          ))}
        </View>
      );
    }

    case 'checkbox':
      return <Text style={styles.display}>{Boolean(value) ? 'Yes' : 'No'}</Text>;

    case 'rating': {
      const n = Number(value) || 0;
      const max = ratingMax(field);
      return (
        <Text style={styles.display}>
          <Text style={styles.starOn}>{'★'.repeat(n)}</Text>
          <Text style={styles.star}>{'★'.repeat(Math.max(0, max - n))}</Text>
          {`  ${n}/${max}`}
        </Text>
      );
    }

    case 'url':
      return <LinkText url={asString(value)} label={asString(value)} />;

    case 'screenshot':
    case 'video': {
      const v = asString(value);
      const url = /^https?:\/\//i.test(v) ? v : blobUrl(v);
      return <LinkText url={url} label={v} />;
    }

    case 'email':
    case 'wallet':
      return <Text style={[styles.display, styles.mono]}>{asString(value)}</Text>;

    default:
      return <Text style={styles.display}>{asString(value)}</Text>;
  }
}

function LinkText({ url, label }: { url: string; label: string }) {
  return (
    <Pressable
      onPress={() => {
        void Linking.openURL(url);
      }}
    >
      <Text style={styles.link} numberOfLines={2}>
        {label} ↗
      </Text>
    </Pressable>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v == null || v === '') return [];
  return [String(v)];
}

function ratingMax(field: Field): number {
  const m = field.validation?.maxRating;
  return typeof m === 'number' && m > 0 ? m : 5;
}

const styles = StyleSheet.create({
  wrap: { gap: 6, marginBottom: 18 },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  label: { color: C.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  req: { color: C.danger },
  privateBadge: {
    backgroundColor: 'rgba(96,165,250,0.12)',
    borderColor: 'rgba(96,165,250,0.4)',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  privateText: { color: C.accent, fontSize: 11, fontWeight: '700' },
  help: { color: C.muted, fontSize: 12.5, marginBottom: 2 },
  note: { color: C.muted, fontSize: 11.5, fontStyle: 'italic' },
  error: { color: C.danger, fontSize: 12.5 },

  input: {
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: C.text,
    fontSize: 15,
  },
  multiline: { minHeight: 110 },
  mono: { fontFamily: 'Courier' },

  optionList: { gap: 8 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  optionActive: { backgroundColor: C.surfaceSel, borderColor: C.borderSel },
  optionText: { color: C.text, fontSize: 14.5 },
  optionTextActive: { color: C.primary, fontWeight: '700' },
  optionCheck: { color: C.primary, fontWeight: '900' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: C.surfaceSel, borderColor: C.borderSel },
  chipText: { color: C.text, fontSize: 13.5 },
  chipTextActive: { color: C.primary, fontWeight: '700' },

  tag: {
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  tagText: { color: C.text, fontSize: 13 },

  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkboxLabel: { color: C.text, fontSize: 14.5 },

  starsRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  star: { color: C.border, fontSize: 28 },
  starOn: { color: C.star },
  ratingValue: { color: C.muted, fontSize: 13, marginLeft: 8 },

  display: { color: C.text, fontSize: 15 },
  displayEmpty: { color: C.muted, fontSize: 15 },
  link: { color: C.accent, fontSize: 14.5, fontWeight: '600' },
});

export default FieldRenderer;
