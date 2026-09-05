import type { SqlPool } from '../auth/postgres-auth-repository.js';
import {
  WorkspaceAccessError,
  type Workspace,
  type WorkspaceRepository,
  type WorkspaceRole,
  type WorkspaceWrite,
} from './service.js';

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly pool: SqlPool) {}

  async list(userId: string): Promise<Workspace[]> {
    const connection = await this.pool.connect();
    try {
      const result = await connection.query<{
        id: string;
        name: string;
        description: string;
        role: WorkspaceRole;
      }>(
        'SELECT w.id, w.name, w.description, m.role FROM workspaces w INNER JOIN workspace_memberships m ON m.workspace_id = w.id WHERE m.user_id = $1 ORDER BY m.created_at, w.id',
        [userId],
      );
      return result.rows;
    } finally {
      connection.release();
    }
  }

  async find(userId: string, workspaceId: string): Promise<Workspace | undefined> {
    const connection = await this.pool.connect();
    try {
      const result = await connection.query<{
        id: string;
        name: string;
        description: string;
        role: WorkspaceRole;
      }>(
        'SELECT w.id, w.name, w.description, m.role FROM workspaces w INNER JOIN workspace_memberships m ON m.workspace_id = w.id WHERE m.user_id = $1 AND w.id = $2',
        [userId, workspaceId],
      );
      return result.rows[0];
    } finally {
      connection.release();
    }
  }

  async create(record: WorkspaceWrite): Promise<Workspace> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(
        'INSERT INTO workspaces (id, name, description, created_at) VALUES ($1, $2, $3, $4)',
        [record.workspaceId, record.name, record.description, record.occurredAt],
      );
      await connection.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)",
        [record.workspaceId, record.actorUserId, record.occurredAt],
      );
      await connection.query(
        "INSERT INTO audit_events (id, event_type, actor_user_id, occurred_at, metadata) VALUES ($1, 'workspace.created', $2, $3, $4::jsonb)",
        [
          record.auditId,
          record.actorUserId,
          record.occurredAt,
          JSON.stringify({ workspaceId: record.workspaceId }),
        ],
      );
      await connection.query('COMMIT');
      return {
        id: record.workspaceId,
        name: record.name,
        description: record.description,
        role: 'owner',
      };
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async update(record: WorkspaceWrite): Promise<Workspace> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const previous = await connection.query<{ name: string; description: string }>(
        "SELECT name, description FROM workspaces WHERE id = $1 AND id IN (SELECT workspace_id FROM workspace_memberships WHERE user_id = $2 AND role IN ('owner', 'administrator')) FOR UPDATE",
        [record.workspaceId, record.actorUserId],
      );
      const row = previous.rows[0];
      if (!row) throw new WorkspaceAccessError();
      const changedFields = (['name', 'description'] as const).filter(
        (field) => row[field] !== record[field],
      );
      const membership = await connection.query<{ role: WorkspaceRole }>(
        "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND role IN ('owner', 'administrator')",
        [record.workspaceId, record.actorUserId],
      );
      const role = membership.rows[0]?.role;
      if (!role) throw new WorkspaceAccessError();
      if (changedFields.length > 0) {
        const updated = await connection.query(
          "UPDATE workspaces SET name = $3, description = $4 WHERE id = $1 AND id IN (SELECT workspace_id FROM workspace_memberships WHERE user_id = $2 AND role IN ('owner', 'administrator')) RETURNING id",
          [record.workspaceId, record.actorUserId, record.name, record.description],
        );
        if (!updated.rows[0]) throw new WorkspaceAccessError();
        await connection.query(
          "INSERT INTO audit_events (id, event_type, actor_user_id, occurred_at, metadata) VALUES ($1, 'workspace.settings_changed', $2, $3, $4::jsonb)",
          [
            record.auditId,
            record.actorUserId,
            record.occurredAt,
            JSON.stringify({ workspaceId: record.workspaceId, changedFields }),
          ],
        );
      }
      await connection.query('COMMIT');
      return { id: record.workspaceId, name: record.name, description: record.description, role };
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}
