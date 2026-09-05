export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const matchingCookies = cookieHeader
    .split(';')
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith('openbot_session='));
  if (matchingCookies.length !== 1) return undefined;
  try {
    const token = decodeURIComponent(matchingCookies[0]?.slice('openbot_session='.length) ?? '');
    return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export function serializeSessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const attributes = [
    `openbot_session=${encodeURIComponent(token)}`,
    'Path=/',
    `Expires=${expiresAt.toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}
