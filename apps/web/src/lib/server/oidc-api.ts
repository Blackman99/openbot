import { parseSessionCookie, type SessionCookie } from './auth-api.js';

export const OIDC_COOKIE_NAME = 'openbot_oidc';
export const OIDC_COOKIE_PATH = '/auth/oidc';
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
export type OidcErrorCode =
  | 'invalid_flow'
  | 'authentication_required'
  | 'provider_unavailable'
  | 'identity_not_linked'
  | 'identity_conflict'
  | 'last_credential'
  | 'invitation_unavailable';
export function isOidcErrorCode(value: unknown): value is OidcErrorCode {
  return (
    typeof value === 'string' &&
    [
      'invalid_flow',
      'authentication_required',
      'provider_unavailable',
      'identity_not_linked',
      'identity_conflict',
      'last_credential',
      'invitation_unavailable',
    ].includes(value)
  );
}
export type OidcResult<T> =
  { status: 'available'; value: T } | { status: 'failed'; code: OidcErrorCode };
export interface OidcStartInput {
  purpose: 'signin' | 'link' | 'invite';
  invitationToken?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function json(response: Response | undefined): Promise<unknown> {
  try {
    return await response?.json();
  } catch {
    return undefined;
  }
}
function failure(payload: unknown): { status: 'failed'; code: OidcErrorCode } {
  const code = record(payload) && record(payload.error) ? payload.error.code : undefined;
  return { status: 'failed', code: isOidcErrorCode(code) ? code : 'provider_unavailable' };
}
function parseBrowserCookie(
  header: string | undefined,
  secure: boolean,
): SessionCookie | undefined {
  if (!header) return undefined;
  const [pair, ...parts] = header.split(';').map((part) => part.trim());
  const value = pair?.match(/^openbot_oidc=([A-Za-z0-9_-]{43})$/u)?.[1];
  const attributes = new Map<string, string | true>();
  for (const part of parts) {
    const split = part.indexOf('=');
    const key = (split < 0 ? part : part.slice(0, split)).toLowerCase();
    if (attributes.has(key)) return undefined;
    attributes.set(key, split < 0 ? true : part.slice(split + 1));
  }
  const expires = new Date(String(attributes.get('expires')));
  if (
    !value ||
    attributes.get('path') !== OIDC_COOKIE_PATH ||
    attributes.get('httponly') !== true ||
    String(attributes.get('samesite')).toLowerCase() !== 'lax' ||
    attributes.has('secure') !== secure ||
    attributes.has('domain') ||
    !Number.isFinite(expires.getTime()) ||
    expires.getTime() <= Date.now()
  )
    return undefined;
  return { value, expires, secure };
}

export class OidcApiClient {
  private readonly base: string;
  private readonly origin: string;
  private readonly secure: boolean;
  constructor(
    private readonly request: typeof fetch,
    apiBaseUrl: string,
    webOrigin: string,
  ) {
    this.base = apiBaseUrl.replace(/\/$/u, '');
    this.origin = new URL(webOrigin).origin;
    this.secure = new URL(this.origin).protocol === 'https:';
  }
  async enabled(): Promise<boolean> {
    const response = await this.send('', 'GET');
    const payload = await json(response);
    return (
      response?.status === 200 &&
      record(payload) &&
      Object.keys(payload).length === 1 &&
      payload.enabled === true
    );
  }
  async identity(session?: string): Promise<OidcResult<{ linked: boolean; canUnlink: boolean }>> {
    const response = await this.send('/identity', 'GET', session);
    const payload = await json(response);
    if (response?.status !== 200) return failure(payload);
    if (
      !record(payload) ||
      Object.keys(payload).length !== 2 ||
      typeof payload.linked !== 'boolean' ||
      typeof payload.canUnlink !== 'boolean' ||
      (!payload.linked && payload.canUnlink)
    )
      return { status: 'failed', code: 'provider_unavailable' };
    return { status: 'available', value: { linked: payload.linked, canUnlink: payload.canUnlink } };
  }
  async unlink(session?: string): Promise<OidcResult<null>> {
    const response = await this.send('/identity', 'DELETE', session);
    return response?.status === 204
      ? { status: 'available', value: null }
      : failure(await json(response));
  }
  async start(
    input: OidcStartInput,
    session?: string,
  ): Promise<OidcResult<{ authorizationUrl: string; cookie: SessionCookie }>> {
    const response = await this.send('/start', 'POST', session, input);
    const payload = await json(response);
    if (response?.status !== 200) return failure(payload);
    const headers = response.headers.getSetCookie();
    const cookie = headers.length === 1 ? parseBrowserCookie(headers[0], this.secure) : undefined;
    if (
      !record(payload) ||
      Object.keys(payload).length !== 1 ||
      typeof payload.authorizationUrl !== 'string' ||
      !cookie
    )
      return { status: 'failed', code: 'provider_unavailable' };
    try {
      const url = new URL(payload.authorizationUrl);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !this.secure)) ||
        url.username ||
        url.password
      )
        return { status: 'failed', code: 'provider_unavailable' };
    } catch {
      return { status: 'failed', code: 'provider_unavailable' };
    }
    return { status: 'available', value: { authorizationUrl: payload.authorizationUrl, cookie } };
  }
  async callback(
    callbackUrl: string,
    browserToken: string | undefined,
    session?: string,
  ): Promise<OidcResult<{ destination: '/app' | '/app/security'; cookie?: SessionCookie }>> {
    const response = await this.send('/callback', 'POST', session, { callbackUrl }, browserToken);
    const payload = await json(response);
    if (response?.status !== 200) return failure(payload);
    if (
      !record(payload) ||
      Object.keys(payload).length !== 1 ||
      (payload.destination !== '/app' && payload.destination !== '/app/security')
    )
      return { status: 'failed', code: 'provider_unavailable' };
    const sessionHeaders = response.headers
      .getSetCookie()
      .filter((header) => header.startsWith('openbot_session='));
    const cookie =
      sessionHeaders.length === 1
        ? parseSessionCookie(sessionHeaders[0] ?? null, this.secure)
        : undefined;
    if (
      sessionHeaders.length > 1 ||
      (sessionHeaders.length && !cookie) ||
      (payload.destination === '/app' && !cookie)
    )
      return { status: 'failed', code: 'provider_unavailable' };
    return {
      status: 'available',
      value: { destination: payload.destination, ...(cookie ? { cookie } : {}) },
    };
  }
  private async send(
    path: string,
    method: string,
    session?: string,
    input?: unknown,
    browserToken?: string,
  ): Promise<Response | undefined> {
    const headers: Record<string, string> = {};
    const cookies: string[] = [];
    if (session && TOKEN.test(session)) cookies.push(`openbot_session=${session}`);
    if (browserToken && TOKEN.test(browserToken))
      cookies.push(`${OIDC_COOKIE_NAME}=${browserToken}`);
    if (cookies.length) headers.cookie = cookies.join('; ');
    if (method !== 'GET') headers.origin = this.origin;
    if (input !== undefined) headers['content-type'] = 'application/json';
    try {
      return await this.request(`${this.base}/api/v1/oidc${path}`, {
        method,
        headers,
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        // SvelteKit must not append unrelated browser cookies to these explicit headers.
        credentials: 'omit',
        // The signal remains active while callers consume the response body.
        redirect: 'error',
        signal: AbortSignal.timeout(method === 'GET' ? 2_000 : 30_000),
      });
    } catch {
      return undefined;
    }
  }
}

export function createOidcApiClient(request: typeof fetch): OidcApiClient {
  return new OidcApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
