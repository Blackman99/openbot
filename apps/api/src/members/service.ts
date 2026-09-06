import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/service.js';
import type { WorkspaceRole } from '../workspaces/service.js';

export type WorkspaceMember = {
  user: AuthenticatedUser;
  role: WorkspaceRole;
  joinedAt: Date;
  invitation: { id: string; invitedBy: { id: string; displayName: string } } | null;
};
export interface MemberRoleWrite {
  actorUserId: string;
  workspaceId: string;
  targetUserId: string;
  role: WorkspaceRole;
  occurredAt: Date;
  auditId: string;
}
export type MemberRemovalWrite = Omit<MemberRoleWrite, 'role'>;
export interface WorkspaceMemberRepository {
  remove(record: MemberRemovalWrite): Promise<void>;
  changeRole(record: MemberRoleWrite): Promise<WorkspaceMember>;
  list(actorUserId: string, workspaceId: string): Promise<WorkspaceMember[]>;
}
export class WorkspaceMemberAccessError extends Error {}
export class WorkspaceMemberNotFoundError extends Error {}
export class LastWorkspaceOwnerError extends Error {}
export class WorkspaceMemberInputError extends Error {}

export class WorkspaceMemberService {
  constructor(private readonly repository: WorkspaceMemberRepository) {}
  changeRole(
    actorUserId: string,
    workspaceId: string,
    targetUserId: string,
    input: unknown,
  ): Promise<WorkspaceMember> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(workspaceId))
      throw new WorkspaceMemberAccessError();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(targetUserId))
      throw new WorkspaceMemberNotFoundError();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !('role' in input) ||
      (input.role !== 'owner' && input.role !== 'administrator' && input.role !== 'member')
    )
      throw new WorkspaceMemberInputError();
    return this.repository.changeRole({
      actorUserId,
      workspaceId,
      targetUserId,
      role: input.role,
      occurredAt: new Date(),
      auditId: randomUUID(),
    });
  }
  remove(actorUserId: string, workspaceId: string, targetUserId: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(workspaceId))
      throw new WorkspaceMemberAccessError();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(targetUserId))
      throw new WorkspaceMemberNotFoundError();
    return this.repository.remove({
      actorUserId,
      workspaceId,
      targetUserId,
      occurredAt: new Date(),
      auditId: randomUUID(),
    });
  }
  list(actorUserId: string, workspaceId: string): Promise<WorkspaceMember[]> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(workspaceId))
      throw new WorkspaceMemberAccessError();
    return this.repository.list(actorUserId, workspaceId);
  }
}
