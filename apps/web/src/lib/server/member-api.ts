import { SESSION_COOKIE_NAME } from './auth-api.js';

export type MemberRole = 'owner' | 'administrator' | 'member';
export interface WorkspaceMember {
  user: { id: string; email: string; displayName: string };
  role: MemberRole;
  joinedAt: string;
  invitation: null | { id: string; invitedBy: { id: string; displayName: string } };
}
export type MemberResult<T> =
  | { status: 'available'; value: T }
  | { status: 'anonymous' | 'forbidden' | 'not-found' | 'invalid' | 'last-owner' | 'unavailable' };
type MemberResponse = { status: number; payload: unknown };

const idPattern = /^[A-Za-z0-9_-]+$/u;
function hasKeys(value: unknown, keys: string): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys
  );
}
function isId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}
function parseMember(value: unknown): WorkspaceMember | undefined {
  if (
    !hasKeys(value, 'invitation,joinedAt,role,user') ||
    !hasKeys(value.user, 'displayName,email,id') ||
    !isId(value.user.id) ||
    typeof value.user.email !== 'string' ||
    typeof value.user.displayName !== 'string' ||
    (value.role !== 'owner' && value.role !== 'administrator' && value.role !== 'member') ||
    typeof value.joinedAt !== 'string' ||
    Number.isNaN(Date.parse(value.joinedAt))
  )
    return undefined;
  let invitation: WorkspaceMember['invitation'] = null;
  if (value.invitation !== null) {
    if (
      !hasKeys(value.invitation, 'id,invitedBy') ||
      !isId(value.invitation.id) ||
      !hasKeys(value.invitation.invitedBy, 'displayName,id') ||
      !isId(value.invitation.invitedBy.id) ||
      typeof value.invitation.invitedBy.displayName !== 'string'
    )
      return undefined;
    invitation = {
      id: value.invitation.id,
      invitedBy: {
        id: value.invitation.invitedBy.id,
        displayName: value.invitation.invitedBy.displayName,
      },
    };
  }
  return {
    user: { id: value.user.id, email: value.user.email, displayName: value.user.displayName },
    role: value.role,
    joinedAt: value.joinedAt,
    invitation,
  };
}
export class MemberApiClient {
  constructor(
    private readonly request: typeof globalThis.fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
  ) {}
  async list(
    session: string | undefined,
    workspaceId: string,
  ): Promise<MemberResult<WorkspaceMember[]>> {
    const result = await this.send(
      session,
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members`,
    );
    if (result.status !== 'available') return result;
    const payload = result.value.payload;
    if (
      result.value.status !== 200 ||
      !hasKeys(payload, 'members') ||
      !Array.isArray(payload.members)
    )
      return { status: 'unavailable' };
    const members: WorkspaceMember[] = [];
    const ids = new Set<string>();
    for (const value of payload.members) {
      const member = parseMember(value);
      if (!member || ids.has(member.user.id)) return { status: 'unavailable' };
      ids.add(member.user.id);
      members.push(member);
    }
    return { status: 'available', value: members };
  }
  async changeRole(
    session: string | undefined,
    workspaceId: string,
    userId: string,
    role: MemberRole,
  ): Promise<MemberResult<WorkspaceMember>> {
    const result = await this.send(
      session,
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: JSON.stringify({ role }) },
    );
    if (result.status !== 'available') return result;
    const payload = result.value.payload;
    const member = hasKeys(payload, 'member') ? parseMember(payload.member) : undefined;
    return result.value.status === 200 &&
      member &&
      member.user.id === userId &&
      member.role === role
      ? { status: 'available', value: member }
      : { status: 'unavailable' };
  }
  async remove(
    session: string | undefined,
    workspaceId: string,
    userId: string,
  ): Promise<MemberResult<undefined>> {
    const result = await this.send(
      session,
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
    if (result.status !== 'available') return result;
    return result.value.status === 204
      ? { status: 'available', value: undefined }
      : { status: 'unavailable' };
  }
  private async send(
    session: string | undefined,
    path: string,
    init: RequestInit = {},
  ): Promise<MemberResult<MemberResponse>> {
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
      if (response.status === 409) {
        const payload: unknown = await response.json().catch(() => undefined);
        return hasKeys(payload, 'error') &&
          hasKeys(payload.error, 'code') &&
          payload.error.code === 'last_owner_required'
          ? { status: 'last-owner' }
          : { status: 'unavailable' };
      }
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
export function createMemberApiClient(request: typeof globalThis.fetch): MemberApiClient {
  return new MemberApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
