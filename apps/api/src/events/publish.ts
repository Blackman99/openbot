import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { appendWorkspaceEvent } from './service.js';
import type { WorkspaceEventType } from './protocol.js';

export async function publishWorkspaceTaskEvent(
  connection: SqlConnection,
  input: {
    workspaceId: string;
    groupId?: string | null;
    type: WorkspaceEventType;
    taskId: string;
    status: string;
    runId?: string;
    occurredAt?: Date;
    extra?: Record<string, unknown>;
  },
) {
  await appendWorkspaceEvent(connection, {
    workspaceId: input.workspaceId,
    groupId: input.groupId ?? null,
    type: input.type,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    data: {
      taskId: input.taskId,
      status: input.status,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.extra ?? {}),
    },
  });
}
