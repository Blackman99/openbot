import { randomUUID } from 'node:crypto';

export type WorkspaceRole = 'owner' | 'administrator' | 'member';
export interface Workspace {
  id: string;
  name: string;
  description: string;
  role: WorkspaceRole;
}
export interface WorkspaceWrite {
  actorUserId: string;
  auditId: string;
  occurredAt: Date;
  workspaceId: string;
  name: string;
  description: string;
}
export interface WorkspaceRepository {
  create(record: WorkspaceWrite): Promise<Workspace>;
  list(userId: string): Promise<Workspace[]>;
  find(userId: string, workspaceId: string): Promise<Workspace | undefined>;
  update(record: WorkspaceWrite): Promise<Workspace>;
}
export class InvalidWorkspaceInputError extends Error {}
export class WorkspaceAccessError extends Error {}

function readSettings(input: unknown): { name: string; description: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InvalidWorkspaceInputError();
  }
  const { name, description = '' } = input as Record<string, unknown>;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 100 ||
    typeof description !== 'string' ||
    description.length > 2000 ||
    /[\u0000-\u001f\u007f]/u.test(name) ||
    description.includes('\0')
  ) {
    throw new InvalidWorkspaceInputError();
  }
  return { name: name.trim(), description: description.trim() };
}

export class WorkspaceService {
  constructor(private readonly repository: WorkspaceRepository) {}

  create(actorUserId: string, input: unknown): Promise<Workspace> {
    const settings = readSettings(input);
    return this.repository.create({
      ...settings,
      actorUserId,
      auditId: randomUUID(),
      occurredAt: new Date(),
      workspaceId: randomUUID(),
    });
  }

  list(userId: string): Promise<Workspace[]> {
    return this.repository.list(userId);
  }

  async get(userId: string, workspaceId: string): Promise<Workspace> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(workspaceId))
      throw new WorkspaceAccessError();
    const workspace = await this.repository.find(userId, workspaceId);
    if (!workspace) throw new WorkspaceAccessError();
    return workspace;
  }

  async update(actorUserId: string, workspaceId: string, input: unknown): Promise<Workspace> {
    await this.get(actorUserId, workspaceId);
    return this.repository.update({
      ...readSettings(input),
      actorUserId,
      workspaceId,
      auditId: randomUUID(),
      occurredAt: new Date(),
    });
  }
}
