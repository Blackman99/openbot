import type { Cookies } from '@sveltejs/kit';

import { SESSION_COOKIE_NAME, type SessionCookie } from './auth-api.js';

type SetHeaders = (headers: Record<string, string>) => void;
const cacheProtectedRequests = new WeakSet<SetHeaders>();

export function preventAuthenticationCaching(setHeaders: SetHeaders): void {
  // An action failure and the following page load share one request header setter.
  if (cacheProtectedRequests.has(setHeaders)) return;
  setHeaders({ 'cache-control': 'private, no-store' });
  cacheProtectedRequests.add(setHeaders);
}

export function readSessionCookie(cookies: Cookies): string | undefined {
  return cookies.get(SESSION_COOKIE_NAME);
}

export function storeSessionCookie(cookies: Cookies, cookie: SessionCookie): void {
  cookies.set(SESSION_COOKIE_NAME, cookie.value, {
    expires: cookie.expires,
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure: cookie.secure,
  });
}

export function clearSessionCookie(cookies: Cookies): void {
  cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
}
