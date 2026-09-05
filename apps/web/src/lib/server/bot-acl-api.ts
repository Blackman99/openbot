import { SESSION_COOKIE_NAME } from './auth-api.js';
import { isBotUuid } from './bot-api.js';

export type BotAclRole = 'owner' | 'editor' | 'user';
export type BotVisibility = 'private' | 'workspace';
export interface BotAclMember {
  user: { id: string; email: string; displayName: string };
  role: BotAclRole;
  joinedAt: string;
  hasWorkspaceAccess: boolean;
}
export type BotAclResult<T> =
  | { status: 'available'; value: T }
  | {
      status:
        | 'anonymous'
        | 'forbidden'
        | 'invalid'
        | 'not-found'
        | 'conflict'
        | 'last-owner'
        | 'unavailable';
    };
type ApiResponse = { status: number; payload: unknown };
function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}
export function isBotAclRole(value: unknown): value is BotAclRole {
  return value === 'owner' || value === 'editor' || value === 'user';
}
function member(value: unknown): BotAclMember | undefined {
  if (
    !keys(value, 'hasWorkspaceAccess,joinedAt,role,user') ||
    !keys(value.user, 'displayName,email,id') ||
    !isBotUuid(value.user.id) ||
    typeof value.user.email !== 'string' ||
    typeof value.user.displayName !== 'string' ||
    !isBotAclRole(value.role) ||
    typeof value.joinedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.joinedAt)) ||
    typeof value.hasWorkspaceAccess !== 'boolean'
  )
    return undefined;
  return {
    user: {
      id: value.user.id.toLowerCase(),
      email: value.user.email,
      displayName: value.user.displayName,
    },
    role: value.role,
    joinedAt: value.joinedAt,
    hasWorkspaceAccess: value.hasWorkspaceAccess,
  };
}
export class BotAclApiClient {
  constructor(
    private readonly request: typeof fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
  ) {}
  async grant(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    userId: string,
    role: BotAclRole = 'user',
  ): Promise<BotAclResult<BotAclMember>> {
    return this.writeMember(session, workspaceId, botId, userId, role, true);
  }
  async changeRole(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    userId: string,
    role: BotAclRole,
  ): Promise<BotAclResult<BotAclMember>> {
    return this.writeMember(session, workspaceId, botId, userId, role, false);
  }
  private async writeMember(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    userId: string,
    role: BotAclRole,
    grant: boolean,
  ): Promise<BotAclResult<BotAclMember>> {
    if (!isBotUuid(userId) || !isBotAclRole(role)) return { status: 'invalid' };
    const result = await this.send(
      session,
      workspaceId,
      botId,
      `/acl${grant ? '' : `/${userId.toLowerCase()}`}`,
      {
        method: grant ? 'POST' : 'PATCH',
        body: JSON.stringify(grant ? { userId: userId.toLowerCase(), role } : { role }),
      },
    );
    if (result.status !== 'available') return result;
    const parsed = keys(result.value.payload, 'member')
      ? member(result.value.payload.member)
      : undefined;
    return result.value.status === (grant ? 201 : 200) &&
      parsed &&
      parsed.user.id === userId.toLowerCase() &&
      parsed.role === role &&
      (!grant || parsed.hasWorkspaceAccess)
      ? { status: 'available', value: parsed }
      : { status: 'unavailable' };
  }
  async revoke(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    userId: string,
  ): Promise<BotAclResult<undefined>> {
    if (!isBotUuid(userId)) return { status: 'invalid' };
    const result = await this.send(session, workspaceId, botId, `/acl/${userId.toLowerCase()}`, {
      method: 'DELETE',
    });
    if (result.status !== 'available') return result;
    return result.value.status === 204
      ? { status: 'available', value: undefined }
      : { status: 'unavailable' };
  }
  async setVisibility(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    visibility: BotVisibility,
  ): Promise<BotAclResult<BotVisibility>> {
    if (visibility !== 'private' && visibility !== 'workspace') return { status: 'invalid' };
    const result = await this.send(session, workspaceId, botId, '/visibility', {
      method: 'PATCH',
      body: JSON.stringify({ visibility }),
    });
    if (result.status !== 'available') return result;
    return result.value.status === 200 &&
      keys(result.value.payload, 'visibility') &&
      result.value.payload.visibility === visibility
      ? { status: 'available', value: visibility }
      : { status: 'unavailable' };
  }
  async list(
    session: string | undefined,
    workspaceId: string,
    botId: string,
  ): Promise<BotAclResult<BotAclMember[]>> {
    const result = await this.send(session, workspaceId, botId, '/acl');
    if (result.status !== 'available') return result;
    const payload = result.value.payload;
    if (result.value.status !== 200 || !keys(payload, 'members') || !Array.isArray(payload.members))
      return { status: 'unavailable' };
    const members: BotAclMember[] = [];
    const ids = new Set<string>();
    for (const value of payload.members) {
      const parsed = member(value);
      if (!parsed || ids.has(parsed.user.id)) return { status: 'unavailable' };
      ids.add(parsed.user.id);
      members.push(parsed);
    }
    return { status: 'available', value: members };
  }
  private async send(
    session: string | undefined,
    workspaceId: string,
    botId: string,
    suffix: string,
    init: RequestInit = {},
  ): Promise<BotAclResult<ApiResponse>> {
    if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return { status: 'anonymous' };
    if (!isBotUuid(workspaceId) || !isBotUuid(botId)) return { status: 'invalid' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.request(
        `${this.baseUrl.replace(/\/$/u, '')}/api/v1/workspaces/${workspaceId.toLowerCase()}/bots/${botId.toLowerCase()}${suffix}`,
        {
          ...init,
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${session}`,
            origin: new URL(this.webOrigin).origin,
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          signal: controller.signal,
        },
      );
      if (response.status === 401) return { status: 'anonymous' };
      const payload: unknown = response.status === 204 ? undefined : await response.json();
      if (keys(payload, 'error') && keys(payload.error, 'code')) {
        const code = payload.error.code;
        if (response.status === 403 && (code === 'bot_forbidden' || code === 'invalid_origin'))
          return { status: 'forbidden' };
        if (response.status === 400 && code === 'invalid_bot_request') return { status: 'invalid' };
        if (response.status === 404 && code === 'bot_acl_member_not_found')
          return { status: 'not-found' };
        if (response.status === 409 && code === 'bot_acl_conflict') return { status: 'conflict' };
        if (response.status === 409 && code === 'last_bot_owner_required')
          return { status: 'last-owner' };
      }
      return response.ok
        ? { status: 'available', value: { status: response.status, payload } }
        : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
export function createBotAclApiClient(request: typeof fetch): BotAclApiClient {
  return new BotAclApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
