/**
 * components/ui.tsx — reusable UI primitives matching the tidalform.xyz design
 * system (lib/theme.ts). Use these instead of hand-rolling styles per screen so
 * the whole app reads like the website.
 *
 *   <Screen>            light page background + safe area
 *   <Card>              white rounded card with soft shadow + border
 *   <GradientButton>    pill button with the brand gradient (primary action)
 *   <OutlineButton>     bordered secondary button
 *   <Field>             labeled text input
 *   <Pill> / <Chip>     small status / selectable tags
 *   <SectionLabel>      uppercase muted section heading
 *   <Banner>            info / success / warn / danger inline banner
 */

import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  brandGradient,
  buttonShadow,
  cardShadow,
  colors,
  gradientEnd,
  gradientStart,
  radius,
} from '@/lib/theme';

export function Screen({
  children,
  scroll: _scroll,
  style,
  edges = ['bottom'],
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: ViewStyle;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
}) {
  return (
    <SafeAreaView style={[s.screen, style]} edges={edges}>
      {children}
    </SafeAreaView>
  );
}

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function GradientButton({
  label,
  onPress,
  loading,
  disabled,
  loadingLabel,
  style,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  loadingLabel?: string;
  style?: ViewStyle;
}) {
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        s.btnWrap,
        buttonShadow,
        off && s.btnOff,
        pressed && !off && s.btnPressed,
        style,
      ]}
    >
      <LinearGradient
        colors={brandGradient as unknown as readonly [string, string, ...string[]]}
        start={gradientStart}
        end={gradientEnd}
        style={s.btnGrad}
      >
        {loading ? (
          <View style={s.btnRow}>
            <ActivityIndicator color={colors.white} />
            {loadingLabel ? (
              <Text style={s.btnText}>{loadingLabel}</Text>
            ) : null}
          </View>
        ) : (
          <Text style={s.btnText}>{label}</Text>
        )}
      </LinearGradient>
    </Pressable>
  );
}

export function OutlineButton({
  label,
  onPress,
  disabled,
  tone = 'default',
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'danger';
  style?: ViewStyle;
}) {
  const color =
    tone === 'primary'
      ? colors.primary
      : tone === 'danger'
        ? colors.danger
        : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.outline,
        disabled && s.btnOff,
        pressed && !disabled && s.outlinePressed,
        style,
      ]}
    >
      <Text style={[s.outlineText, { color }]}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  error,
  style,
  ...input
}: {
  label?: string;
  hint?: string;
  error?: string;
  style?: ViewStyle;
} & TextInputProps) {
  return (
    <View style={[{ gap: 6 }, style]}>
      {label ? <Text style={s.fieldLabel}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.subtle}
        style={[s.input, error ? s.inputError : null]}
        {...input}
      />
      {error ? (
        <Text style={s.errText}>{error}</Text>
      ) : hint ? (
        <Text style={s.hintText}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function Pill({
  label,
  tone = 'muted',
}: {
  label: string;
  tone?: 'muted' | 'primary' | 'success' | 'warning' | 'danger' | 'teal';
}) {
  const c = toneColor(tone);
  return (
    <View style={[s.pill, { borderColor: c.border, backgroundColor: c.bg }]}>
      <Text style={[s.pillText, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

export function Chip({
  label,
  active,
  onPress,
  tone = 'primary',
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  tone?: 'primary' | 'muted' | 'danger' | 'warning' | 'success';
}) {
  const c = toneColor(tone);
  return (
    <Pressable
      onPress={onPress}
      style={[
        s.chip,
        active
          ? { backgroundColor: c.fg, borderColor: c.fg }
          : { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <Text
        style={[
          s.chipText,
          { color: active ? colors.white : colors.muted },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={s.sectionLabel}>{children}</Text>;
}

export function Banner({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'success' | 'warning' | 'danger';
}) {
  const map = {
    info: { border: colors.primary, bg: '#0890BA14', fg: colors.primaryDeep },
    success: { border: colors.success, bg: '#1EA46314', fg: colors.success },
    warning: { border: colors.warning, bg: '#F6930914', fg: '#9A5B00' },
    danger: { border: colors.danger, bg: '#DE353514', fg: colors.danger },
  }[tone];
  return (
    <View style={[s.banner, { borderColor: map.border, backgroundColor: map.bg }]}>
      <Text style={[s.bannerText, { color: map.fg }]}>{children}</Text>
    </View>
  );
}

function toneColor(tone: string): { fg: string; bg: string; border: string } {
  switch (tone) {
    case 'primary':
      return { fg: colors.primary, bg: '#0890BA14', border: '#0890BA40' };
    case 'teal':
      return { fg: colors.teal, bg: '#18B48F14', border: '#18B48F40' };
    case 'success':
      return { fg: colors.success, bg: '#1EA46314', border: '#1EA46340' };
    case 'warning':
      return { fg: colors.warning, bg: '#F6930914', border: '#F6930940' };
    case 'danger':
      return { fg: colors.danger, bg: '#DE353514', border: '#DE353540' };
    default:
      return { fg: colors.muted, bg: colors.surfaceLift, border: colors.border };
  }
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: 18,
    ...cardShadow,
  },

  btnWrap: { borderRadius: radius.pill, overflow: 'hidden' },
  btnOff: { opacity: 0.45 },
  btnPressed: { transform: [{ translateY: 1 }] },
  btnGrad: {
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  btnText: { color: colors.white, fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },

  outline: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  outlinePressed: { backgroundColor: colors.surfaceLift },
  outlineText: { fontSize: 15, fontWeight: '700' },

  fieldLabel: { color: colors.text, fontSize: 14, fontWeight: '700' },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.input,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text,
  },
  inputError: { borderColor: colors.danger },
  errText: { color: colors.danger, fontSize: 12.5 },
  hintText: { color: colors.subtle, fontSize: 12.5 },

  pill: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  pillText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },

  chip: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipText: { fontSize: 12.5, fontWeight: '700' },

  sectionLabel: {
    color: colors.subtle,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },

  banner: { borderRadius: 12, padding: 12, borderWidth: 1 },
  bannerText: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
});
