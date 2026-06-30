/**
 * lib/theme.ts — the Tideform / tidalform.xyz design tokens, ported from the
 * website's globals.css (light theme, the site default).
 *
 *   background  #F8FAFC   white cards on a near-white blue-tinted canvas
 *   primary     brand gradient (cyan → teal → indigo), used on pill buttons
 *   text        deep navy   #10182D
 *
 * Import `colors` everywhere instead of per-screen palettes so the whole app
 * matches the website.
 */

import { Platform } from 'react-native';

export const colors = {
  bg: '#F8FAFC',
  surface: '#FFFFFF',
  surfaceLift: '#F0F4F9',
  surfaceStrong: '#E4EBF7',

  text: '#10182D',
  muted: '#556177',
  subtle: '#8D9BB0',

  border: '#D7DEEA',
  borderBright: '#B7C5D7',

  primary: '#0890BA',
  primaryDeep: '#0B4F83',
  teal: '#18B48F',
  indigo: '#554ACF',
  coral: '#F57047',

  success: '#1EA463',
  warning: '#F69309',
  danger: '#DE3535',

  white: '#FFFFFF',
} as const;

/** The website's `.brand-gradient` stops (135°): primary → teal → indigo. */
export const brandGradient = ['#0890BA', '#18B48F', '#554ACF'] as const;
/** Diagonal start/end approximating the CSS 135deg angle. */
export const gradientStart = { x: 0, y: 0 } as const;
export const gradientEnd = { x: 1, y: 1 } as const;

export const radius = {
  card: 16,
  input: 12,
  chip: 10,
  pill: 999,
} as const;

export const space = { xs: 6, sm: 10, md: 14, lg: 18, xl: 24 } as const;

/** Soft product shadow (RN approximation of the site's product-shadow). */
export const cardShadow = {
  shadowColor: '#0F172A',
  shadowOffset: { width: 0, height: 12 },
  shadowOpacity: 0.1,
  shadowRadius: 24,
  elevation: 3,
} as const;

export const buttonShadow = {
  shadowColor: '#0890BA',
  shadowOffset: { width: 0, height: 12 },
  shadowOpacity: 0.32,
  shadowRadius: 22,
  elevation: 5,
} as const;

export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
}) as string;

/** Truncate a Sui address for display: 0x1234…abcd. */
export function shortAddr(a: string): string {
  return a && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}
