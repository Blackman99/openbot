import { randomUUID } from 'node:crypto';
import { BotAccessError, BotInputError, type BotRole } from './service.js';
import type { BotAccess } from './postgres-bot-access.js';

export interface BotAclMember {
  user: { id: string; email: string; displayName: string };
  role: BotRole;
  joinedAt: Date;
  hasWorkspaceAccess: boolean;
}
export interface BotAclRemoval extends BotAccess {
  targetUserId: string;
  auditId: string;
}
export interface BotAclGrant extends BotAclRemoval {
  role: BotRole;
}
export interface BotVisibilityChange extends BotAccess {
  visibility: 'private' | 'workspace';
  auditId: string;
}
export interface BotAclRepository {
  list(access: BotAccess): Promise<BotAclMember[]>;
  grant(record: BotAclGrant): Promise<BotAclMember>;
  changeRole(record: BotAclGrant): Promise<BotAclMember>;
  revoke(record: BotAclRemoval): Promise<void>;
  changeVisibility(record: BotVisibilityChange): Promise<{ visibility: 'private' | 'workspace' }>;
}
export class BotAclConflictError extends Error {}
export class BotAclMemberNotFoundError extends Error {}
export class LastBotOwnerError extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function access(actorUserId: string, workspaceId: string, botId: string): BotAccess {
  if (!uuid.test(workspaceId) || !uuid.test(botId)) throw new BotAccessError();
  return {
    actorUserId: actorUserId.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    botId: botId.toLowerCase(),
  };
}
export class BotAclService {
  constructor(private readonly repository: BotAclRepository) {}
  list(actorUserId: string, workspaceId: string, botId: string) {
    return this.repository.list(access(actorUserId, workspaceId, botId));
  }
  changeRole(
    actorUserId: string,
    workspaceId: string,
    botId: string,
    targetUserId: string,
    input: unknown,
  ) {
    const scope = access(actorUserId, workspaceId, botId);
    if (
      !uuid.test(targetUserId) ||
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'role') ||
      !('role' in input) ||
      (input.role !== 'owner' && input.role !== 'editor' && input.role !== 'user')
    )
      throw new BotInputError();
    return this.repository.changeRole({
      ...scope,
      targetUserId: targetUserId.toLowerCase(),
      role: input.role,
      auditId: randomUUID(),
    });
  }
  revoke(actorUserId: string, workspaceId: string, botId: string, targetUserId: string) {
    const scope = access(actorUserId, workspaceId, botId);
    if (!uuid.test(targetUserId)) throw new BotInputError();
    return this.repository.revoke({
      ...scope,
      targetUserId: targetUserId.toLowerCase(),
      auditId: randomUUID(),
    });
  }
  changeVisibility(actorUserId: string, workspaceId: string, botId: string, input: unknown) {
    const scope = access(actorUserId, workspaceId, botId);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'visibility') ||
      !('visibility' in input) ||
      (input.visibility !== 'private' && input.visibility !== 'workspace')
    )
      throw new BotInputError();
    return this.repository.changeVisibility({
      ...scope,
      visibility: input.visibility,
      auditId: randomUUID(),
    });
  }
  grant(actorUserId: string, workspaceId: string, botId: string, input: unknown) {
    const scope = access(actorUserId, workspaceId, botId);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['userId', 'role'].includes(key)) ||
      !('userId' in input) ||
      typeof input.userId !== 'string' ||
      !uuid.test(input.userId)
    )
      throw new BotInputError();
    const role = 'role' in input ? input.role : 'user';
    if (role !== 'owner' && role !== 'editor' && role !== 'user') throw new BotInputError();
    return this.repository.grant({
      ...scope,
      targetUserId: input.userId.toLowerCase(),
      role,
      auditId: randomUUID(),
    });
  }
}
