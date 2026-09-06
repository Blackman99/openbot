import { randomUUID } from 'node:crypto';
import type { TransactionAdmission } from '../database/transaction-admission.js';

export type GroupRole = 'owner' | 'admin' | 'member';
export type GroupVisibility = 'private' | 'workspace';
export interface Group {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  visibility: GroupVisibility;
  role: GroupRole | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface PublicGroup extends Group {
  archivedAt: Date | null;
  policy: { maxConcurrentRuns: number };
}
export interface GroupCreate {
  id: string;
  workspaceId: string;
  actorId: string;
  name: string;
  description: string;
  visibility: GroupVisibility;
  maxConcurrentRuns?: number;
  occurredAt: Date;
  auditId: string;
}
export interface GroupMember {
  user: { id: string; email: string; displayName: string };
  role: GroupRole;
  joinedAt: Date;
  hasWorkspaceAccess: boolean;
}
export type GroupContentAccess = Group & { role: GroupRole };
export interface GroupMemberWrite {
  actorId: string;
  workspaceId: string;
  groupId: string;
  targetUserId: string;
  role: GroupRole;
  occurredAt: Date;
  auditId: string;
}
export type GroupMemberRemoval = Omit<GroupMemberWrite, 'role'>;
export interface GroupMetadataWrite {
  actorId: string;
  workspaceId: string;
  groupId: string;
  changes: {
    name?: string;
    description?: string;
    visibility?: GroupVisibility;
    maxConcurrentRuns?: number;
  };
  occurredAt: Date;
  auditId: string;
}
export interface GroupArchiveWrite {
  actorId: string;
  workspaceId: string;
  groupId: string;
  occurredAt: Date;
  auditId: string;
}
export interface GroupRepository {
  create(record: GroupCreate, admission?: TransactionAdmission): Promise<Group>;
  list(
    actorId: string,
    workspaceId: string,
    options?: { includeArchived?: boolean },
    admission?: TransactionAdmission,
  ): Promise<Group[]>;
  get(
    actorId: string,
    workspaceId: string,
    groupId: string,
    admission?: TransactionAdmission,
  ): Promise<Group>;
  inspect(
    actorId: string,
    workspaceId: string,
    groupId: string,
    admission?: TransactionAdmission,
  ): Promise<PublicGroup>;
  members(
    actorId: string,
    workspaceId: string,
    groupId: string,
    admission?: TransactionAdmission,
  ): Promise<GroupMember[]>;
  authorizeContent(
    actorId: string,
    workspaceId: string,
    groupId: string,
  ): Promise<GroupContentAccess>;
  addMember(record: GroupMemberWrite, admission?: TransactionAdmission): Promise<GroupMember>;
  changeRole(record: GroupMemberWrite, admission?: TransactionAdmission): Promise<GroupMember>;
  removeMember(record: GroupMemberRemoval, admission?: TransactionAdmission): Promise<void>;
  update(record: GroupMetadataWrite, admission?: TransactionAdmission): Promise<Group>;
  archive(record: GroupArchiveWrite, admission?: TransactionAdmission): Promise<PublicGroup>;
}
export class GroupAccessError extends Error {}
export class GroupInputError extends Error {}
export class GroupMemberNotFoundError extends Error {}
export class GroupMemberConflictError extends Error {}
export class LastGroupOwnerError extends Error {}
export class GroupArchivedError extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function parseConcurrentRuns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 10_000)
    throw new GroupInputError();
  return value;
}

export class GroupService {
  constructor(private readonly repository: GroupRepository) {}
  update(
    actorId: string,
    workspaceId: string,
    groupId: string,
    input: unknown,
    admission?: TransactionAdmission,
  ): Promise<Group> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length === 0 ||
      Object.keys(input).some(
        (key) => !['name', 'description', 'visibility', 'maxConcurrentRuns'].includes(key),
      )
    )
      throw new GroupInputError();
    const changes: GroupMetadataWrite['changes'] = {};
    if ('name' in input) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100)
        throw new GroupInputError();
      changes.name = input.name.trim();
    }
    if ('description' in input) {
      if (typeof input.description !== 'string' || input.description.length > 2000)
        throw new GroupInputError();
      changes.description = input.description.trim();
    }
    if ('visibility' in input) {
      if (input.visibility !== 'private' && input.visibility !== 'workspace')
        throw new GroupInputError();
      changes.visibility = input.visibility;
    }
    if ('maxConcurrentRuns' in input)
      changes.maxConcurrentRuns = parseConcurrentRuns(input.maxConcurrentRuns);
    return this.repository.update(
      {
        actorId: actorId.toLowerCase(),
        workspaceId: workspaceId.toLowerCase(),
        groupId: groupId.toLowerCase(),
        changes,
        occurredAt: new Date(),
        auditId: randomUUID(),
      },
      admission,
    );
  }
  archive(
    actorId: string,
    workspaceId: string,
    groupId: string,
    admission?: TransactionAdmission,
  ): Promise<PublicGroup> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    return this.repository.archive(
      {
        actorId: actorId.toLowerCase(),
        workspaceId: workspaceId.toLowerCase(),
        groupId: groupId.toLowerCase(),
        occurredAt: new Date(),
        auditId: randomUUID(),
      },
      admission,
    );
  }
  inspect(
    actorId: string,
    workspaceId: string,
    groupId: string,
    admission?: TransactionAdmission,
  ): Promise<PublicGroup> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    return this.repository.inspect(
      actorId.toLowerCase(),
      workspaceId.toLowerCase(),
      groupId.toLowerCase(),
      admission,
    );
  }
  removeMember(
    actorId: string,
    workspaceId: string,
    groupId: string,
    targetUserId: string,
    admission?: TransactionAdmission,
  ): Promise<void> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    if (!uuid.test(targetUserId)) throw new GroupInputError();
    return this.repository.removeMember(
      {
        actorId: actorId.toLowerCase(),
        workspaceId: workspaceId.toLowerCase(),
        groupId: groupId.toLowerCase(),
        targetUserId: targetUserId.toLowerCase(),
        occurredAt: new Date(),
        auditId: randomUUID(),
      },
      admission,
    );
  }
  changeRole(
    actorId: string,
    workspaceId: string,
    groupId: string,
    targetUserId: string,
    input: unknown,
    admission?: TransactionAdmission,
  ): Promise<GroupMember> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    if (
      !uuid.test(targetUserId) ||
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !('role' in input) ||
      (input.role !== 'owner' && input.role !== 'admin' && input.role !== 'member')
    )
      throw new GroupInputError();
    return this.repository.changeRole(
      {
        actorId: actorId.toLowerCase(),
        workspaceId: workspaceId.toLowerCase(),
        groupId: groupId.toLowerCase(),
        targetUserId: targetUserId.toLowerCase(),
        role: input.role,
        occurredAt: new Date(),
        auditId: randomUUID(),
      },
      admission,
    );
  }
  addMember(
    actorId: string,
    workspaceId: string,
    groupId: string,
    input: unknown,
    admission?: TransactionAdmission,
  ): Promise<GroupMember> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !('userId' in input) ||
      typeof input.userId !== 'string' ||
      !uuid.test(input.userId)
    )
      throw new GroupInputError();
    const role = 'role' in input ? input.role : 'member';
    if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new GroupInputError();
    return this.repository.addMember(
      {
        actorId: actorId.toLowerCase(),
        workspaceId: workspaceId.toLowerCase(),
        groupId: groupId.toLowerCase(),
        targetUserId: input.userId.toLowerCase(),
        role,
        occurredAt: new Date(),
        auditId: randomUUID(),
      },
      admission,
    );
  }
  members(
    actorId: string,
    workspaceId: string,
    groupId: string,
    admission?: TransactionAdmission,
  ): Promise<GroupMember[]> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    return this.repository.members(
      actorId.toLowerCase(),
      workspaceId.toLowerCase(),
      groupId.toLowerCase(),
      admission,
    );
  }
  // Authorization is a current snapshot, never a reusable content capability.
  authorizeContent(
    actorId: string,
    workspaceId: string,
    groupId: string,
  ): Promise<GroupContentAccess> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    return this.repository.authorizeContent(
      actorId.toLowerCase(),
      workspaceId.toLowerCase(),
      groupId.toLowerCase(),
    );
  }
  authorizeSubscription(
    actorId: string,
    workspaceId: string,
    groupId: string,
  ): Promise<GroupContentAccess> {
    return this.authorizeContent(actorId, workspaceId, groupId);
  }
  list(
    actorId: string,
    workspaceId: string,
    options?: { includeArchived?: boolean },
    admission?: TransactionAdmission,
  ): Promise<Group[]> {
    if (!uuid.test(workspaceId)) throw new GroupAccessError();
    return this.repository.list(
      actorId.toLowerCase(),
      workspaceId.toLowerCase(),
      options,
      admission,
    );
  }
  get(
    actorId: string,
    workspaceId: string,
    groupId: string,
    admission?: TransactionAdmission,
  ): Promise<Group> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    return this.repository.get(
      actorId.toLowerCase(),
      workspaceId.toLowerCase(),
      groupId.toLowerCase(),
      admission,
    );
  }
  create(
    actorId: string,
    workspaceId: string,
    input: unknown,
    admission?: TransactionAdmission,
  ): Promise<Group> {
    if (!uuid.test(workspaceId)) throw new GroupAccessError();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !('name' in input) ||
      typeof input.name !== 'string'
    )
      throw new GroupInputError();
    const name = input.name.trim();
    const description = 'description' in input ? input.description : '';
    const visibility = 'visibility' in input ? input.visibility : 'private';
    if (
      !name ||
      name.length > 100 ||
      typeof description !== 'string' ||
      description.length > 2000 ||
      (visibility !== 'private' && visibility !== 'workspace')
    )
      throw new GroupInputError();
    const maxConcurrentRuns =
      'maxConcurrentRuns' in input ? parseConcurrentRuns(input.maxConcurrentRuns) : undefined;
    return this.repository.create(
      {
        id: randomUUID(),
        actorId: actorId.toLowerCase(),
        workspaceId: workspaceId.toLowerCase(),
        name,
        description: description.trim(),
        visibility,
        ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
        occurredAt: new Date(),
        auditId: randomUUID(),
      },
      admission,
    );
  }
}
