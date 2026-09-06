import { SESSION_COOKIE_NAME } from './auth-api.js';

export interface ApiTokenMetadata {
  id: string;
  creatorUserId: string;
  workspaceId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface ApiTokenInput {
  name: string;
  scopes: string[];
  expiresAt: string;
}
export interface ApiTokenList {
  tokens: ApiTokenMetadata[];
  availableScopes: string[];
}
export type ApiTokenResult<T> =
  | { status: 'available'; value: T }
  | { status: 'anonymous' | 'forbidden' | 'not-found' | 'invalid' | 'unavailable' };
type ApiResponse = { status: number; payload: unknown };
function hasKeys(value: unknown, keys: string): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys
  );
}
function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value);
}
function sameWorkspaceId(actual: string, requested: string): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  return uuid.test(actual) && uuid.test(requested)
    ? actual.toLowerCase() === requested.toLowerCase()
    : actual === requested;
}
function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function isScopes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 9 &&
    value.every(
      (scope) =>
        typeof scope === 'string' &&
        /^(?:me:read|bots:(?:read|write)|groups:(?:read|write)|tasks:(?:read|write|approve)|events:read)$/u.test(
          scope,
        ),
    ) &&
    new Set(value).size === value.length
  );
}
function parseToken(value: unknown): ApiTokenMetadata | undefined {
  if (
    !hasKeys(
      value,
      'createdAt,creatorUserId,expiresAt,id,lastUsedAt,name,revokedAt,scopes,workspaceId',
    ) ||
    !isId(value.id) ||
    !isId(value.creatorUserId) ||
    !isId(value.workspaceId) ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 100 ||
    !isScopes(value.scopes) ||
    !isDate(value.createdAt) ||
    !isDate(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.createdAt) ||
    (value.lastUsedAt !== null && !isDate(value.lastUsedAt)) ||
    (value.revokedAt !== null && !isDate(value.revokedAt))
  )
    return undefined;
  return {
    id: value.id,
    creatorUserId: value.creatorUserId,
    workspaceId: value.workspaceId,
    name: value.name,
    scopes: value.scopes,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    lastUsedAt: value.lastUsedAt,
    revokedAt: value.revokedAt,
  };
}
export class ApiTokenApiClient {
  constructor(
    private readonly request: typeof globalThis.fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
  ) {}
  async list(
    session: string | undefined,
    workspaceId: string,
  ): Promise<ApiTokenResult<ApiTokenList>> {
    const result = await this.send(session, this.path(workspaceId));
    if (result.status !== 'available') return result;
    const { payload, status } = result.value;
    if (
      status !== 200 ||
      !hasKeys(payload, 'availableScopes,tokens') ||
      !isScopes(payload.availableScopes) ||
      !Array.isArray(payload.tokens)
    )
      return { status: 'unavailable' };
    const tokens: ApiTokenMetadata[] = [];
    const ids = new Set<string>();
    for (const value of payload.tokens) {
      const token = parseToken(value);
      if (!token || !sameWorkspaceId(token.workspaceId, workspaceId) || ids.has(token.id))
        return { status: 'unavailable' };
      ids.add(token.id);
      tokens.push(token);
    }
    return { status: 'available', value: { tokens, availableScopes: payload.availableScopes } };
  }
  async create(
    session: string | undefined,
    workspaceId: string,
    input: ApiTokenInput,
  ): Promise<ApiTokenResult<{ token: ApiTokenMetadata; secret: string }>> {
    const result = await this.send(session, this.path(workspaceId), {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (result.status !== 'available') return result;
    const { payload, status } = result.value;
    if (
      status !== 201 ||
      !hasKeys(payload, 'secret,token') ||
      typeof payload.secret !== 'string' ||
      !/^ob_[A-Za-z0-9_-]{43}$/u.test(payload.secret)
    )
      return { status: 'unavailable' };
    const token = parseToken(payload.token);
    if (!token || !sameWorkspaceId(token.workspaceId, workspaceId))
      return { status: 'unavailable' };
    return { status: 'available', value: { token, secret: payload.secret } };
  }
  async revoke(
    session: string | undefined,
    workspaceId: string,
    tokenId: string,
  ): Promise<ApiTokenResult<undefined>> {
    const result = await this.send(
      session,
      `${this.path(workspaceId)}/${encodeURIComponent(tokenId)}`,
      { method: 'DELETE' },
    );
    if (result.status !== 'available') return result;
    return result.value.status === 204
      ? { status: 'available', value: undefined }
      : { status: 'unavailable' };
  }
  private path(workspaceId: string): string {
    return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/api-tokens`;
  }
  private async send(
    session: string | undefined,
    path: string,
    init: RequestInit = {},
  ): Promise<ApiTokenResult<ApiResponse>> {
    if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return { status: 'anonymous' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.request(`${this.baseUrl.replace(/\/$/u, '')}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          origin: new URL(this.webOrigin).origin,
          cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}`,
        },
        signal: controller.signal,
      });
      if (response.status === 401) return { status: 'anonymous' };
      if (response.status === 403) return { status: 'forbidden' };
      if (response.status === 404) return { status: 'not-found' };
      if (response.status === 400) return { status: 'invalid' };
      if (!response.ok) return { status: 'unavailable' };
      const payload: unknown = response.status === 204 ? undefined : await response.json();
      return { status: 'available', value: { status: response.status, payload } };
    } catch {
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
export function createApiTokenApiClient(request: typeof globalThis.fetch): ApiTokenApiClient {
  return new ApiTokenApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
