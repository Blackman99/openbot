import {
  SESSION_COOKIE_NAME,
  parseIdentity,
  parseSessionCookie,
  parseRetryAfterSeconds,
  type AuthIdentity,
  type SessionCookie,
} from './auth-api.js';

export interface Invitation {
  id: string;
  workspaceId: string;
  email: string;
  role: 'member' | 'administrator';
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  consumedAt: string | null;
}
export type InvitationResult<T> =
  | { status: 'available'; value: T }
  | { status: 'rate-limited'; retryAfterSeconds?: number }
  | { status: 'anonymous' | 'forbidden' | 'not-found' | 'invalid' | 'conflict' | 'unavailable' };
type InvitationResponse = { status: number; headers: Headers; payload: unknown };
export interface CreateInvitationInput {
  email: string;
  role: 'member' | 'administrator';
  expiresInDays: number;
}
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseInvitation(value: unknown): Invitation | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !==
      'consumedAt,createdAt,email,expiresAt,id,revokedAt,role,workspaceId' ||
    typeof value.id !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(value.id) ||
    typeof value.workspaceId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(value.workspaceId) ||
    typeof value.email !== 'string' ||
    (value.role !== 'member' && value.role !== 'administrator') ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    typeof value.expiresAt !== 'string' ||
    Number.isNaN(Date.parse(value.expiresAt)) ||
    (value.revokedAt !== null &&
      (typeof value.revokedAt !== 'string' || Number.isNaN(Date.parse(value.revokedAt)))) ||
    (value.consumedAt !== null &&
      (typeof value.consumedAt !== 'string' || Number.isNaN(Date.parse(value.consumedAt))))
  )
    return undefined;
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    email: value.email,
    role: value.role,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    revokedAt: value.revokedAt,
    consumedAt: value.consumedAt,
  };
}
export class InvitationApiClient {
  constructor(
    private readonly request: typeof globalThis.fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
  ) {}
  async create(
    session: string | undefined,
    workspaceId: string,
    input: CreateInvitationInput,
  ): Promise<InvitationResult<{ invitation: Invitation; token: string }>> {
    const result = await this.send(
      session,
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
      { method: 'POST', body: JSON.stringify(input) },
    );
    if (result.status !== 'available') return result;
    const payload = result.value.payload;
    const invitation =
      isRecord(payload) && Object.keys(payload).sort().join(',') === 'invitation,token'
        ? parseInvitation(payload.invitation)
        : undefined;
    return invitation &&
      invitation.workspaceId === workspaceId &&
      isRecord(payload) &&
      typeof payload.token === 'string' &&
      tokenPattern.test(payload.token)
      ? { status: 'available', value: { invitation, token: payload.token } }
      : { status: 'unavailable' };
  }
  async list(
    session: string | undefined,
    workspaceId: string,
  ): Promise<InvitationResult<Invitation[]>> {
    const result = await this.send(
      session,
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
    );
    if (result.status !== 'available') return result;
    const payload = result.value.payload;
    if (
      !isRecord(payload) ||
      Object.keys(payload).join(',') !== 'invitations' ||
      !Array.isArray(payload.invitations)
    )
      return { status: 'unavailable' };
    const invitations: Invitation[] = [];
    for (const value of payload.invitations) {
      const invitation = parseInvitation(value);
      if (!invitation || invitation.workspaceId !== workspaceId) return { status: 'unavailable' };
      invitations.push(invitation);
    }
    return { status: 'available', value: invitations };
  }
  async revoke(
    session: string | undefined,
    workspaceId: string,
    invitationId: string,
  ): Promise<InvitationResult<undefined>> {
    const result = await this.send(
      session,
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: 'DELETE' },
    );
    if (result.status !== 'available') return result;
    return result.value.status === 204
      ? { status: 'available', value: undefined }
      : { status: 'unavailable' };
  }
  async accept(
    session: string | undefined,
    input: { token: string; email?: string; displayName?: string; password?: string },
  ): Promise<
    InvitationResult<{
      identity: AuthIdentity & { workspace: NonNullable<AuthIdentity['workspace']> };
      cookie?: SessionCookie;
    }>
  > {
    if (!tokenPattern.test(input.token)) return { status: 'conflict' };
    const result = await this.send(
      session,
      '/api/v1/invitations/accept',
      { method: 'POST', body: JSON.stringify(input) },
      true,
    );
    if (result.status !== 'available') return result;
    const identity = parseIdentity(result.value.payload);
    if (!identity || !identity.workspace || !/^[A-Za-z0-9_-]+$/u.test(identity.workspace.id))
      return { status: 'unavailable' };
    const workspaceIdentity = { user: identity.user, workspace: identity.workspace };
    if (result.value.status === 200 && session && !result.value.headers.has('set-cookie'))
      return { status: 'available', value: { identity: workspaceIdentity } };
    const cookie = parseSessionCookie(
      result.value.headers.get('set-cookie'),
      new URL(this.webOrigin).protocol === 'https:',
    );
    return result.value.status === 201 && !session && cookie
      ? { status: 'available', value: { identity: workspaceIdentity, cookie } }
      : { status: 'unavailable' };
  }
  private async send(
    session: string | undefined,
    path: string,
    init: RequestInit = {},
    allowAnonymous = false,
  ): Promise<InvitationResult<InvitationResponse>> {
    if ((!session && !allowAnonymous) || (session && !tokenPattern.test(session)))
      return { status: 'anonymous' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.request(`${this.baseUrl.replace(/\/$/u, '')}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          origin: new URL(this.webOrigin).origin,
          ...(session ? { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}` } : {}),
        },
        signal: controller.signal,
      });
      if (response.status === 401) return { status: 'anonymous' };
      if (response.status === 403) return { status: 'forbidden' };
      if (response.status === 404) return { status: 'not-found' };
      if (response.status === 400) return { status: 'invalid' };
      if (response.status === 409) return { status: 'conflict' };
      if (response.status === 429) {
        const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
        return retryAfterSeconds === undefined
          ? { status: 'rate-limited' }
          : { status: 'rate-limited', retryAfterSeconds };
      }
      if (!response.ok) return { status: 'unavailable' };
      const payload: unknown = response.status === 204 ? undefined : await response.json();
      return {
        status: 'available',
        value: { status: response.status, headers: response.headers, payload },
      };
    } catch {
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
export function createInvitationApiClient(request: typeof globalThis.fetch): InvitationApiClient {
  return new InvitationApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
