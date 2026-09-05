export const SESSION_COOKIE_NAME = 'openbot_session';

export interface AuthIdentity {
  user: {
    displayName: string;
    email: string;
    id: string;
  };
  workspace: {
    id: string;
    name: string;
  } | null;
}

export interface SessionCookie {
  expires: Date;
  secure: boolean;
  value: string;
}

export interface SetupInput {
  displayName: string;
  email: string;
  password: string;
  setupToken: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

export type ClaimStateResult =
  { claimed: boolean; status: 'available' } | { status: 'unavailable' };

export type IdentityResult =
  | { identity: AuthIdentity; status: 'authenticated' }
  | { status: 'anonymous' }
  | { status: 'unavailable' };

export type AuthenticationResult =
  | { cookie: SessionCookie; identity: AuthIdentity; status: 'authenticated' }
  | { status: 'already-claimed' }
  | { status: 'invalid-setup-token' }
  | { status: 'invalid-credentials' }
  | { status: 'invalid-request' }
  | { retryAfterSeconds?: number; status: 'rate-limited' }
  | { status: 'unavailable' };

export type SignOutResult =
  { secure: boolean; status: 'signed-out' } | { status: 'anonymous' } | { status: 'unavailable' };

const AUTH_READ_TIMEOUT_MS = 2_000;
const PASSWORD_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_SECONDS = 86_400;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

export function parseIdentity(value: unknown): AuthIdentity | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['user', 'workspace']) ||
    !isRecord(value.user) ||
    !hasOnlyKeys(value.user, ['displayName', 'email', 'id']) ||
    typeof value.user.displayName !== 'string' ||
    typeof value.user.email !== 'string' ||
    typeof value.user.id !== 'string'
  )
    return undefined;
  let workspace: AuthIdentity['workspace'] = null;
  if (value.workspace !== null) {
    if (
      !isRecord(value.workspace) ||
      !hasOnlyKeys(value.workspace, ['id', 'name']) ||
      typeof value.workspace.id !== 'string' ||
      typeof value.workspace.name !== 'string'
    )
      return undefined;
    workspace = { id: value.workspace.id, name: value.workspace.name };
  }
  return {
    user: { displayName: value.user.displayName, email: value.user.email, id: value.user.id },
    workspace,
  };
}

export function parseSessionCookie(
  header: string | null,
  expectedSecure: boolean,
): SessionCookie | undefined {
  if (!header) {
    return undefined;
  }

  const parts = header.split(';').map((part) => part.trim());
  const value = parts.shift()?.match(/^openbot_session=([A-Za-z0-9_-]{43})$/u)?.[1];
  const attributes = new Map<string, string | true>();
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      attributes.set(part.toLowerCase(), true);
    } else {
      attributes.set(part.slice(0, separator).toLowerCase(), part.slice(separator + 1));
    }
  }

  const expiresValue = attributes.get('expires');
  const expires = typeof expiresValue === 'string' ? new Date(expiresValue) : undefined;
  const secure = attributes.has('secure');
  if (
    !value ||
    !SESSION_TOKEN_PATTERN.test(value) ||
    attributes.get('path') !== '/' ||
    attributes.get('httponly') !== true ||
    String(attributes.get('samesite')).toLowerCase() !== 'lax' ||
    secure !== expectedSecure ||
    !expires ||
    Number.isNaN(expires.getTime())
  ) {
    return undefined;
  }

  return { expires, secure, value };
}

function isValidClearCookie(header: string | null, expectedSecure: boolean): boolean {
  if (!header) {
    return false;
  }

  const parts = header.split(';').map((part) => part.trim().toLowerCase());
  const secure = parts.includes('secure');
  return (
    parts[0] === `${SESSION_COOKIE_NAME}=` &&
    parts.includes('path=/') &&
    parts.includes('max-age=0') &&
    parts.includes('httponly') &&
    parts.includes('samesite=lax') &&
    secure === expectedSecure
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value || !/^(?:0|[1-9]\d{0,4})$/u.test(value)) {
    return undefined;
  }

  const seconds = Number(value);
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined;
}

export class AuthApiClient {
  private readonly apiBaseUrl: string;
  private readonly secureCookie: boolean;
  private readonly trustedOrigin: string;

  constructor(
    private readonly request: typeof globalThis.fetch,
    apiBaseUrl: string,
    trustedOrigin: string,
  ) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/u, '');
    this.trustedOrigin = new URL(trustedOrigin).origin;
    this.secureCookie = new URL(this.trustedOrigin).protocol === 'https:';
  }

  async getClaimState(): Promise<ClaimStateResult> {
    const response = await this.send('/api/v1/auth/state');
    if (!response?.ok) {
      return { status: 'unavailable' };
    }

    const payload = await readJson(response);
    return isRecord(payload) &&
      hasOnlyKeys(payload, ['claimed']) &&
      typeof payload.claimed === 'boolean'
      ? { status: 'available', claimed: payload.claimed }
      : { status: 'unavailable' };
  }

  async getIdentity(sessionToken: string | undefined): Promise<IdentityResult> {
    if (!sessionToken) {
      return { status: 'anonymous' };
    }

    const response = await this.send('/api/v1/me', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}` },
    });
    if (response?.status === 401) {
      return { status: 'anonymous' };
    }
    if (!response?.ok) {
      return { status: 'unavailable' };
    }

    const identity = parseIdentity(await readJson(response));
    return identity ? { status: 'authenticated', identity } : { status: 'unavailable' };
  }

  setup(input: SetupInput): Promise<AuthenticationResult> {
    const { setupToken, ...credentials } = input;
    return this.authenticate('/api/v1/setup', credentials, {
      'x-openbot-setup-token': setupToken,
    });
  }

  signIn(input: SignInInput): Promise<AuthenticationResult> {
    return this.authenticate('/api/v1/session', input);
  }

  async signOut(sessionToken: string | undefined): Promise<SignOutResult> {
    if (!sessionToken) {
      return { status: 'anonymous' };
    }

    const response = await this.send('/api/v1/session', {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
        origin: this.trustedOrigin,
      },
      method: 'DELETE',
    });
    if (response?.status === 401) {
      return { status: 'anonymous' };
    }
    if (
      response?.status !== 204 ||
      !isValidClearCookie(response.headers.get('set-cookie'), this.secureCookie)
    ) {
      return { status: 'unavailable' };
    }

    return { status: 'signed-out', secure: this.secureCookie };
  }

  private async authenticate(
    path: string,
    input: Omit<SetupInput, 'setupToken'> | SignInInput,
    extraHeaders: Record<string, string> = {},
  ): Promise<AuthenticationResult> {
    const response = await this.send(
      path,
      {
        body: JSON.stringify(input),
        headers: {
          'content-type': 'application/json',
          origin: this.trustedOrigin,
          ...extraHeaders,
        },
        method: 'POST',
      },
      PASSWORD_REQUEST_TIMEOUT_MS,
    );
    const payload = response ? await readJson(response) : undefined;
    if (response?.status === 401) {
      return { status: 'invalid-credentials' };
    }
    if (response?.status === 403 && path === '/api/v1/setup') {
      return { status: 'invalid-setup-token' };
    }
    if (response?.status === 409) {
      return { status: 'already-claimed' };
    }
    if (response?.status === 400) {
      return { status: 'invalid-request' };
    }
    if (response?.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
      return retryAfterSeconds === undefined
        ? { status: 'rate-limited' }
        : { status: 'rate-limited', retryAfterSeconds };
    }
    if (!response?.ok) {
      return { status: 'unavailable' };
    }

    const identity = parseIdentity(payload);
    const cookie = parseSessionCookie(response.headers.get('set-cookie'), this.secureCookie);
    return identity && cookie
      ? { status: 'authenticated', identity, cookie }
      : { status: 'unavailable' };
  }

  private async send(
    path: string,
    init: RequestInit = {},
    timeoutMs = AUTH_READ_TIMEOUT_MS,
  ): Promise<Response | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.request(`${this.apiBaseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createAuthApiClient(request: typeof globalThis.fetch): AuthApiClient {
  return new AuthApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
