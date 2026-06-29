/**
 * lib/cookies.ts — manual session-cookie persistence for the Zentos backend.
 *
 * GOTCHA (source-of-truth §12): the backend sets an HttpOnly session cookie, but
 * Expo/React Native `fetch` does NOT persist cookies like a browser. So we:
 *   1. capture `Set-Cookie` from privileged responses (notably /api/auth/google),
 *   2. store the merged cookie string in `expo-secure-store`,
 *   3. re-attach it as a `Cookie` header on every subsequent privileged call.
 *
 * `cookieFetch` is the single wrapper that does (1) + (3). lib/api.ts builds on it.
 *
 * (Swift's `Lib/` gets this for free via a shared URLSession + HTTPCookieStorage.)
 */

import * as SecureStore from 'expo-secure-store';

const COOKIE_KEY = 'tideform.session.cookie';

// In-memory mirror so the hot path doesn't hit SecureStore on every request.
let cache: string | null | undefined;

async function rawGet(): Promise<string | null> {
  if (cache !== undefined) return cache;
  try {
    cache = await SecureStore.getItemAsync(COOKIE_KEY);
  } catch {
    cache = null;
  }
  return cache;
}

async function rawSet(value: string): Promise<void> {
  cache = value;
  try {
    await SecureStore.setItemAsync(COOKIE_KEY, value);
  } catch {
    // Non-fatal: an in-memory cookie still works for the current session.
  }
}

/** The stored `Cookie` header value, e.g. `"zentos_session=abc; other=xyz"`, or null. */
export async function getCookieHeader(): Promise<string | null> {
  const v = await rawGet();
  return v && v.length > 0 ? v : null;
}

/** Forget the session (used on sign-out). */
export async function clearCookie(): Promise<void> {
  cache = null;
  try {
    await SecureStore.deleteItemAsync(COOKIE_KEY);
  } catch {
    // ignore
  }
}

// ── Set-Cookie parsing ────────────────────────────────────────────────────────

/**
 * Split a combined `Set-Cookie` header into individual cookie strings.
 *
 * React Native often folds multiple Set-Cookie headers into one comma-joined
 * string; a naive split on "," breaks on `Expires=Wed, 21 Oct ...`. This is the
 * well-known `set-cookie-parser` splitter, which only treats a comma as a
 * separator when it's followed by a `name=` token.
 */
export function splitCookiesString(header: string): string[] {
  const out: string[] = [];
  let pos = 0;
  let start: number;
  let ch: string;
  let lastComma: number;
  let nextStart: number;
  let separatorFound: boolean;

  const skipWs = () => {
    while (pos < header.length && /\s/.test(header.charAt(pos))) pos += 1;
    return pos < header.length;
  };
  const notSpecial = () => {
    ch = header.charAt(pos);
    return ch !== '=' && ch !== ';' && ch !== ',';
  };

  while (pos < header.length) {
    start = pos;
    separatorFound = false;
    while (skipWs()) {
      ch = header.charAt(pos);
      if (ch === ',') {
        lastComma = pos;
        pos += 1;
        skipWs();
        nextStart = pos;
        while (pos < header.length && notSpecial()) pos += 1;
        if (pos < header.length && header.charAt(pos) === '=') {
          separatorFound = true;
          pos = nextStart;
          out.push(header.substring(start, lastComma));
          start = pos;
        } else {
          pos = lastComma + 1;
        }
      } else {
        pos += 1;
      }
    }
    if (!separatorFound || pos >= header.length) {
      out.push(header.substring(start, header.length));
    }
  }
  return out;
}

function parseCookieMap(headerValue: string | null): Record<string, string> {
  const map: Record<string, string> = {};
  if (!headerValue) return map;
  for (const pair of headerValue.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    map[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return map;
}

function serializeCookieMap(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Capture and persist any `Set-Cookie` from a backend response, merging with
 * whatever we already hold (later values overwrite earlier ones by name).
 */
export async function captureSetCookie(res: Response): Promise<void> {
  // RN exposes a non-standard combined header; the Headers type lacks it in TS.
  const raw =
    res.headers.get('set-cookie') ??
    (res.headers as unknown as { map?: Record<string, string> }).map?.[
      'set-cookie'
    ] ??
    null;
  if (!raw) return;

  const existing = parseCookieMap(await rawGet());
  for (const cookieStr of splitCookiesString(raw)) {
    // The cookie's name=value is everything before the first attribute (`;`).
    const nameValue = cookieStr.split(';')[0]?.trim();
    if (!nameValue) continue;
    const eq = nameValue.indexOf('=');
    if (eq <= 0) continue;
    existing[nameValue.slice(0, eq).trim()] = nameValue.slice(eq + 1).trim();
  }
  await rawSet(serializeCookieMap(existing));
}

/**
 * `fetch` wrapper that attaches the stored session cookie and captures any
 * `Set-Cookie` from the response. Use for every privileged backend call.
 */
export async function cookieFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const cookie = await getCookieHeader();
  if (cookie) headers.set('Cookie', cookie);

  // We manage cookies manually; tell the platform not to also try to.
  const res = await fetch(input, { ...init, headers, credentials: 'omit' });
  await captureSetCookie(res);
  return res;
}
