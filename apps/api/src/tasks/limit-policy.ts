import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { conversationUuid } from '../conversations/service.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import {
  LimitAccessError,
  LimitInputError,
  parseExecutionPolicy,
  type ExecutionLimitPolicy,
} from './execution-limits.js';

export class ExecutionLimitService {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  putWorkspacePolicy(actorUserId: string, workspaceId: string, input: unknown) {
    const actor = conversationUuid(actorUserId),
      workspace = conversationUuid(workspaceId),
      policy = parseExecutionPolicy(input);
    if (!Object.keys(policy).length) throw new LimitInputError();
    return this.transaction(async (connection) => {
      await requireWorkspaceManager(connection, workspace, actor);
      await connection.query('UPDATE workspaces SET execution_policy=$2::jsonb WHERE id=$1', [
        workspace,
        JSON.stringify(policy),
      ]);
      return policy;
    });
  }

  putGroupPolicy(actorUserId: string, workspaceId: string, groupId: string, input: unknown) {
    const actor = conversationUuid(actorUserId),
      workspace = conversationUuid(workspaceId),
      group = conversationUuid(groupId),
      policy = parseExecutionPolicy(input);
    if (!Object.keys(policy).length) throw new LimitInputError();
    return this.transaction(async (connection) => {
      await lockAuthorizedGroup(
        connection,
        { actorId: actor, workspaceId: workspace, groupId: group },
        'manage',
      );
      await connection.query('UPDATE groups SET execution_policy=$2::jsonb WHERE id=$1', [
        group,
        JSON.stringify(policy),
      ]);
      return policy;
    });
  }

  private async transaction<T>(operation: (connection: SqlConnection) => Promise<T>) {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await operation(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}

export async function requireWorkspaceManager(
  connection: SqlConnection,
  workspaceId: string,
  actorUserId: string,
) {
  const member = (
    await connection.query<{ role: string }>(
      "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','administrator')",
      [workspaceId, actorUserId],
    )
  ).rows[0];
  if (!member) throw new LimitAccessError();
}

export type { ExecutionLimitPolicy };
