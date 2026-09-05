import { randomUUID } from 'node:crypto';

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
export interface GroupCreate {
  id: string;
  workspaceId: string;
  actorId: string;
  name: string;
  description: string;
  visibility: GroupVisibility;
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
  changes: { name?: string; description?: string; visibility?: GroupVisibility };
  occurredAt: Date;
  auditId: string;
}
export interface GroupRepository {
  create(record: GroupCreate): Promise<Group>;
  list(actorId: string, workspaceId: string): Promise<Group[]>;
  get(actorId: string, workspaceId: string, groupId: string): Promise<Group>;
  members(actorId: string, workspaceId: string, groupId: string): Promise<GroupMember[]>;
  authorizeContent(
    actorId: string,
    workspaceId: string,
    groupId: string,
  ): Promise<GroupContentAccess>;
  addMember(record: GroupMemberWrite): Promise<GroupMember>;
  changeRole(record: GroupMemberWrite): Promise<GroupMember>;
  removeMember(record: GroupMemberRemoval): Promise<void>;
  update(record: GroupMetadataWrite): Promise<Group>;
}
export class GroupAccessError extends Error {}
export class GroupInputError extends Error {}
export class GroupMemberNotFoundError extends Error {}
export class GroupMemberConflictError extends Error {}
export class LastGroupOwnerError extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export class GroupService {
  constructor(private readonly repository: GroupRepository) {}
  update(actorId: string, workspaceId: string, groupId: string, input: unknown): Promise<Group> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length === 0 ||
      Object.keys(input).some((key) => !['name', 'description', 'visibility'].includes(key))
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
    return this.repository.update({
      actorId: actorId.toLowerCase(),
      workspaceId: workspaceId.toLowerCase(),
      groupId: groupId.toLowerCase(),
      changes,
      occurredAt: new Date(),
      auditId: randomUUID(),
    });
  }
  removeMember(
    actorId: string,
    workspaceId: string,
    groupId: string,
    targetUserId: string,
  ): Promise<void> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    if (!uuid.test(targetUserId)) throw new GroupInputError();
    return this.repository.removeMember({
      actorId: actorId.toLowerCase(),
      workspaceId: workspaceId.toLowerCase(),
      groupId: groupId.toLowerCase(),
      targetUserId: targetUserId.toLowerCase(),
      occurredAt: new Date(),
      auditId: randomUUID(),
    });
  }
  changeRole(
    actorId: string,
    workspaceId: string,
    groupId: string,
    targetUserId: string,
    input: unknown,
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
    return this.repository.changeRole({
      actorId: actorId.toLowerCase(),
      workspaceId: workspaceId.toLowerCase(),
      groupId: groupId.toLowerCase(),
      targetUserId: targetUserId.toLowerCase(),
      role: input.role,
      occurredAt: new Date(),
      auditId: randomUUID(),
    });
  }
  addMember(
    actorId: string,
    workspaceId: string,
    groupId: string,
    input: unknown,
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
    return this.repository.addMember({
      actorId: actorId.toLowerCase(),
      workspaceId: workspaceId.toLowerCase(),
      groupId: groupId.toLowerCase(),
      targetUserId: input.userId.toLowerCase(),
      role,
      occurredAt: new Date(),
      auditId: randomUUID(),
    });
  }
  members(actorId: string, workspaceId: string, groupId: string): Promise<GroupMember[]> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    return this.repository.members(
      actorId.toLowerCase(),
      workspaceId.toLowerCase(),
      groupId.toLowerCase(),
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
  list(actorId: string, workspaceId: string): Promise<Group[]> {
    if (!uuid.test(workspaceId)) throw new GroupAccessError();
    return this.repository.list(actorId.toLowerCase(), workspaceId.toLowerCase());
  }
  get(actorId: string, workspaceId: string, groupId: string): Promise<Group> {
    if (!uuid.test(workspaceId) || !uuid.test(groupId)) throw new GroupAccessError();
    return this.repository.get(
      actorId.toLowerCase(),
      workspaceId.toLowerCase(),
      groupId.toLowerCase(),
    );
  }
  create(actorId: string, workspaceId: string, input: unknown): Promise<Group> {
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
    return this.repository.create({
      id: randomUUID(),
      actorId: actorId.toLowerCase(),
      workspaceId: workspaceId.toLowerCase(),
      name,
      description: description.trim(),
      visibility,
      occurredAt: new Date(),
      auditId: randomUUID(),
    });
  }
}
