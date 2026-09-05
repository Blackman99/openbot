import type { AuthenticatedUser } from '../auth/service.js';
import type { WorkspaceRole } from '../workspaces/service.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { TransactionAdmission } from '../database/transaction-admission.js';

export const API_TOKEN_SCOPES = [
  'me:read',
  'bots:read',
  'bots:write',
  'groups:read',
  'groups:write',
  'tasks:read',
  'tasks:write',
  'tasks:approve',
  'events:read',
] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];
export interface ApiToken {
  id: string;
  creatorUserId: string;
  workspaceId: string;
  name: string;
  scopes: ApiTokenScope[];
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}
export interface CreateApiTokenRecord {
  token: ApiToken;
  tokenDigest: string;
  auditId: string;
}
export interface ApiTokenIdentity {
  user: AuthenticatedUser;
  workspace: { id: string; name: string; role: WorkspaceRole };
  token: { id: string; scopes: ApiTokenScope[] };
}
export interface AuthorizeApiTokenRecord {
  tokenDigest: string;
  requiredScope: ApiTokenScope;
  auditId: string;
}
export interface RevokeApiTokenRecord {
  actorUserId: string;
  workspaceId: string;
  tokenId: string;
  occurredAt: Date;
  auditId: string;
}
export interface RecheckApiTokenRecord {
  tokenDigest: string;
  requiredScope: ApiTokenScope;
  tokenId: string;
  creatorUserId: string;
  workspaceId: string;
}
export interface ApiTokenRepository {
  assertCurrent(
    connection: SqlConnection,
    record: RecheckApiTokenRecord,
    clock: () => Date,
  ): Promise<void>;
  list(creatorUserId: string, workspaceId: string): Promise<ApiToken[]>;
  revoke(record: RevokeApiTokenRecord): Promise<void>;
  authorize(
    record: AuthorizeApiTokenRecord,
    clock: () => Date,
  ): Promise<ApiTokenIdentity | 'insufficient_scope' | undefined>;
  create(record: CreateApiTokenRecord, clock: () => Date): Promise<ApiToken>;
}
export class ApiTokenInputError extends Error {}
export class ApiTokenAccessError extends Error {}
export class ApiTokenNotFoundError extends Error {}
export class ApiTokenAuthenticationError extends Error {}
export class ApiTokenScopeError extends Error {}
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function normalizeWorkspaceId(workspaceId: string): string {
  if (!idPattern.test(workspaceId)) throw new ApiTokenAccessError();
  return workspaceId.toLowerCase();
}
export function digestApiToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
export class ApiTokenService {
  constructor(
    private readonly repository: ApiTokenRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  list(creatorUserId: string, workspaceId: string): Promise<ApiToken[]> {
    workspaceId = normalizeWorkspaceId(workspaceId);
    return this.repository.list(creatorUserId, workspaceId);
  }
  revoke(actorUserId: string, workspaceId: string, tokenId: string): Promise<void> {
    workspaceId = normalizeWorkspaceId(workspaceId);
    if (!idPattern.test(tokenId)) throw new ApiTokenNotFoundError();
    return this.repository.revoke({
      actorUserId,
      workspaceId,
      tokenId: tokenId.toLowerCase(),
      occurredAt: this.clock(),
      auditId: randomUUID(),
    });
  }
  async authorize(secret: string, requiredScope: ApiTokenScope): Promise<ApiTokenIdentity> {
    if (!/^ob_[A-Za-z0-9_-]{43}$/u.test(secret)) throw new ApiTokenAuthenticationError();
    const identity = await this.repository.authorize(
      {
        tokenDigest: digestApiToken(secret),
        requiredScope,
        auditId: randomUUID(),
      },
      this.clock,
    );
    if (!identity) throw new ApiTokenAuthenticationError();
    if (identity === 'insufficient_scope') throw new ApiTokenScopeError();
    return identity;
  }
  async authorizeResource(
    secret: string,
    requiredScope: ApiTokenScope,
  ): Promise<{
    identity: ApiTokenIdentity;
    admit: TransactionAdmission;
  }> {
    const identity = await this.authorize(secret, requiredScope);
    const record: RecheckApiTokenRecord = {
      tokenDigest: digestApiToken(secret),
      requiredScope,
      tokenId: identity.token.id,
      creatorUserId: identity.user.id,
      workspaceId: identity.workspace.id,
    };
    return {
      identity,
      admit: (connection) => this.repository.assertCurrent(connection, record, this.clock),
    };
  }
  async create(
    creatorUserId: string,
    workspaceId: string,
    input: unknown,
  ): Promise<{ token: ApiToken; secret: string }> {
    workspaceId = normalizeWorkspaceId(workspaceId);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiTokenInputError();
    const value = input as Record<string, unknown>;
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const now = this.clock();
    const expiresAt =
      typeof value.expiresAt === 'string' ? new Date(value.expiresAt) : new Date(NaN);
    if (
      name.length < 1 ||
      name.length > 100 ||
      !Array.isArray(value.scopes) ||
      value.scopes.length < 1 ||
      value.scopes.length > API_TOKEN_SCOPES.length ||
      value.scopes.some((scope) => !API_TOKEN_SCOPES.some((allowed) => allowed === scope)) ||
      new Set(value.scopes).size !== value.scopes.length ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= now ||
      expiresAt.getTime() > now.getTime() + 365 * 86_400_000
    )
      throw new ApiTokenInputError();
    const scopes = API_TOKEN_SCOPES.filter(
      (scope) => value.scopes instanceof Array && value.scopes.includes(scope),
    );
    const token: ApiToken = {
      id: randomUUID(),
      creatorUserId,
      workspaceId,
      name,
      scopes,
      createdAt: now,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    const secret = `ob_${randomBytes(32).toString('base64url')}`;
    const created = await this.repository.create(
      {
        token,
        tokenDigest: digestApiToken(secret),
        auditId: randomUUID(),
      },
      this.clock,
    );
    return { token: created, secret };
  }
}
