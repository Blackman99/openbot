import { SESSION_COOKIE_NAME } from './auth-api.js';
export type GroupRole = 'owner' | 'admin' | 'member';
export type GroupVisibility = 'private' | 'workspace';
export interface Group {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  visibility: GroupVisibility;
  role: GroupRole | null;
  createdAt: string;
  updatedAt: string;
}
export type GroupResult<T> =
  | { status: 'available'; value: T }
  | {
      status:
        | 'anonymous'
        | 'forbidden'
        | 'not-found'
        | 'invalid'
        | 'conflict'
        | 'last-owner'
        | 'unavailable';
    };
export interface GroupInput {
  name: string;
  description?: string;
  visibility?: GroupVisibility;
}
export function normalizeUuid(value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    ? value.toLowerCase()
    : value;
}
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
function isRole(value: unknown): value is GroupRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}
function isDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
function parseGroup(value: unknown, workspaceId: string): Group | undefined {
  if (
    !hasKeys(value, 'createdAt,description,id,name,role,updatedAt,visibility,workspaceId') ||
    !isId(value.id) ||
    value.workspaceId !== normalizeUuid(workspaceId) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 100 ||
    typeof value.description !== 'string' ||
    value.description.length > 2000 ||
    (value.visibility !== 'private' && value.visibility !== 'workspace') ||
    (value.role !== null && !isRole(value.role)) ||
    !isDate(value.createdAt) ||
    !isDate(value.updatedAt) ||
    (value.visibility === 'private' && value.role === null)
  )
    return undefined;
  return {
    id: value.id,
    workspaceId: normalizeUuid(workspaceId),
    name: value.name,
    description: value.description,
    visibility: value.visibility,
    role: value.role,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
export interface GroupMember {
  user: { id: string; email: string; displayName: string };
  role: GroupRole;
  joinedAt: string;
  hasWorkspaceAccess: boolean;
}
function parseMember(value: unknown): GroupMember | undefined {
  if (
    !hasKeys(value, 'hasWorkspaceAccess,joinedAt,role,user') ||
    !hasKeys(value.user, 'displayName,email,id') ||
    !isId(value.user.id) ||
    typeof value.user.email !== 'string' ||
    typeof value.user.displayName !== 'string' ||
    !isRole(value.role) ||
    !isDate(value.joinedAt) ||
    typeof value.hasWorkspaceAccess !== 'boolean'
  )
    return undefined;
  return {
    user: { id: value.user.id, email: value.user.email, displayName: value.user.displayName },
    role: value.role,
    joinedAt: value.joinedAt,
    hasWorkspaceAccess: value.hasWorkspaceAccess,
  };
}
type GroupResponse = { status: number; payload: unknown };
export class GroupApiClient {
  constructor(
    private readonly request: typeof globalThis.fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
  ) {}
  private path(workspaceId: string, groupId?: string) {
    return `/api/v1/workspaces/${encodeURIComponent(normalizeUuid(workspaceId))}/groups${groupId ? `/${encodeURIComponent(normalizeUuid(groupId))}` : ''}`;
  }
  async create(
    session: string | undefined,
    workspaceId: string,
    input: GroupInput,
  ): Promise<GroupResult<Group>> {
    const result = await this.send(session, this.path(workspaceId), {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (result.status !== 'available') return result;
    const group = hasKeys(result.value.payload, 'group')
      ? parseGroup(result.value.payload.group, workspaceId)
      : undefined;
    return result.value.status === 201 && group && group.role === 'owner'
      ? { status: 'available', value: group }
      : { status: 'unavailable' };
  }
  async list(session: string | undefined, workspaceId: string): Promise<GroupResult<Group[]>> {
    const result = await this.send(session, this.path(workspaceId));
    if (result.status !== 'available') return result;
    const payload = result.value.payload;
    if (
      result.value.status !== 200 ||
      !hasKeys(payload, 'groups') ||
      !Array.isArray(payload.groups)
    )
      return { status: 'unavailable' };
    const groups: Group[] = [];
    const ids = new Set<string>();
    for (const value of payload.groups) {
      const group = parseGroup(value, workspaceId);
      if (!group || ids.has(group.id)) return { status: 'unavailable' };
      ids.add(group.id);
      groups.push(group);
    }
    return { status: 'available', value: groups };
  }
  async get(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
  ): Promise<GroupResult<Group>> {
    return this.readGroup(
      await this.send(session, this.path(workspaceId, groupId)),
      workspaceId,
      groupId,
    );
  }
  async update(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    input: Partial<GroupInput>,
  ): Promise<GroupResult<Group>> {
    return this.readGroup(
      await this.send(session, this.path(workspaceId, groupId), {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
      workspaceId,
      groupId,
    );
  }
  private readGroup(
    result: GroupResult<GroupResponse>,
    workspaceId: string,
    groupId: string,
  ): GroupResult<Group> {
    if (result.status !== 'available') return result;
    const group = hasKeys(result.value.payload, 'group')
      ? parseGroup(result.value.payload.group, workspaceId)
      : undefined;
    return result.value.status === 200 && group?.id === normalizeUuid(groupId)
      ? { status: 'available', value: group }
      : { status: 'unavailable' };
  }
  async members(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
  ): Promise<GroupResult<GroupMember[]>> {
    const result = await this.send(session, `${this.path(workspaceId, groupId)}/members`);
    if (result.status !== 'available') return result;
    const payload = result.value.payload;
    if (
      result.value.status !== 200 ||
      !hasKeys(payload, 'members') ||
      !Array.isArray(payload.members)
    )
      return { status: 'unavailable' };
    const members: GroupMember[] = [];
    const ids = new Set<string>();
    for (const value of payload.members) {
      const member = parseMember(value);
      if (!member || ids.has(member.user.id)) return { status: 'unavailable' };
      ids.add(member.user.id);
      members.push(member);
    }
    return { status: 'available', value: members };
  }
  async addMember(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    userId: string,
    role: GroupRole,
  ): Promise<GroupResult<GroupMember>> {
    return this.readMember(
      await this.send(session, `${this.path(workspaceId, groupId)}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: normalizeUuid(userId), role }),
      }),
      userId,
      role,
      201,
    );
  }
  async changeRole(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    userId: string,
    role: GroupRole,
  ): Promise<GroupResult<GroupMember>> {
    return this.readMember(
      await this.send(
        session,
        `${this.path(workspaceId, groupId)}/members/${encodeURIComponent(normalizeUuid(userId))}`,
        { method: 'PATCH', body: JSON.stringify({ role }) },
      ),
      userId,
      role,
      200,
    );
  }
  private readMember(
    result: GroupResult<GroupResponse>,
    userId: string,
    role: GroupRole,
    status: number,
  ): GroupResult<GroupMember> {
    if (result.status !== 'available') return result;
    const member = hasKeys(result.value.payload, 'member')
      ? parseMember(result.value.payload.member)
      : undefined;
    return result.value.status === status &&
      member &&
      member.user.id === normalizeUuid(userId) &&
      member.role === role
      ? { status: 'available', value: member }
      : { status: 'unavailable' };
  }
  async removeMember(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    userId: string,
  ): Promise<GroupResult<undefined>> {
    const result = await this.send(
      session,
      `${this.path(workspaceId, groupId)}/members/${encodeURIComponent(normalizeUuid(userId))}`,
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
  ): Promise<GroupResult<GroupResponse>> {
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
        const payload: unknown = await response.json();
        if (!hasKeys(payload, 'error') || !hasKeys(payload.error, 'code'))
          return { status: 'unavailable' };
        return {
          status:
            payload.error.code === 'last_group_owner_required'
              ? 'last-owner'
              : payload.error.code === 'group_member_conflict'
                ? 'conflict'
                : 'unavailable',
        };
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
export function createGroupApiClient(request: typeof globalThis.fetch) {
  return new GroupApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
