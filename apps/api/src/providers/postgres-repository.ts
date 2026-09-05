import { randomUUID } from 'node:crypto';
import type { SqlPool, SqlConnection } from '../auth/postgres-auth-repository.js';
import type { ConnectionMetadata, ConnectionRecord, ProviderRepository } from './connections.js';
import type { ConnectionAccess, ConnectionAuthority, ConnectionPermission } from './scope.js';
import { ProviderError } from './url-policy.js';

type Row = { metadata: ConnectionMetadata; sealed_credentials: string; revision: number };
function storage(access: ConnectionAccess) {
  return access.scope.kind === 'personal'
    ? { table: 'personal_model_connections', key: 'owner_user_id' }
    : { table: 'workspace_model_connections', key: 'workspace_id' };
}
function fromRow(
  row: Row,
  access: ConnectionAccess,
  authority: ConnectionAuthority,
): ConnectionRecord {
  return {
    access,
    canManage: authority.canManage,
    metadata: { ...row.metadata, protocol: row.metadata.protocol ?? 'openai-chat' },
    sealedCredentials: row.sealed_credentials,
    revision: row.revision,
  };
}
export class PostgresProviderRepository implements ProviderRepository {
  constructor(private readonly pool: SqlPool) {}

  authorize(
    access: ConnectionAccess,
    permission: ConnectionPermission,
  ): Promise<ConnectionAuthority> {
    return this.withAccess(access, permission, async (_connection, authority) => authority);
  }
  private async withAccess<T>(
    access: ConnectionAccess,
    permission: ConnectionPermission,
    operation: (connection: SqlConnection, authority: ConnectionAuthority) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      let canManage = true;
      if (access.scope.kind === 'workspace') {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(access.scope.id)
        )
          throw new ProviderError('workspace_forbidden');
        const workspace = await connection.query(
          'SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',
          [access.scope.id],
        );
        if (!workspace.rows[0]) throw new ProviderError('workspace_forbidden');
        const member = await connection.query<{ role: string }>(
          'SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
          [access.scope.id, access.actorUserId],
        );
        if (!member.rows[0]) throw new ProviderError('workspace_forbidden');
        canManage = ['owner', 'administrator'].includes(member.rows[0].role);
        if (permission === 'manage' && !canManage) throw new ProviderError('workspace_forbidden');
      } else if (access.scope.id !== access.actorUserId)
        throw new ProviderError('connection_not_found');
      const result = await operation(connection, { canManage });
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  private audit(connection: SqlConnection, access: ConnectionAccess, id: string, event: string) {
    return connection.query(
      'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
      [
        randomUUID(),
        event,
        access.actorUserId,
        new Date(),
        JSON.stringify({
          ...(access.scope.kind === 'workspace' ? { workspaceId: access.scope.id } : {}),
          connectionId: id,
        }),
      ],
    );
  }
  async insert(record: ConnectionRecord): Promise<void> {
    const { table, key } = storage(record.access);
    await this.withAccess(record.access, 'manage', async (connection) => {
      await connection.query(
        `INSERT INTO ${table}(id,${key},metadata,sealed_credentials,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$5,$5)`,
        [
          record.metadata.id,
          record.access.scope.id,
          JSON.stringify(record.metadata),
          record.sealedCredentials,
          new Date(),
        ],
      );
      await this.audit(
        connection,
        record.access,
        record.metadata.id,
        'provider.connection_created',
      );
    });
  }
  find(
    access: ConnectionAccess,
    id: string,
    permission: ConnectionPermission = 'read',
  ): Promise<ConnectionRecord | undefined> {
    const { table, key } = storage(access);
    return this.withAccess(access, permission, async (connection, authority) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id))
        return undefined;
      const result = await connection.query<Row>(
        `SELECT metadata,sealed_credentials,revision FROM ${table} WHERE ${key}=$1 AND id=$2`,
        [access.scope.id, id],
      );
      return result.rows[0] ? fromRow(result.rows[0], access, authority) : undefined;
    });
  }
  list(access: ConnectionAccess): Promise<{ canManage: boolean; records: ConnectionRecord[] }> {
    const { table, key } = storage(access);
    return this.withAccess(access, 'read', async (connection, authority) => {
      const result = await connection.query<Row>(
        `SELECT metadata,sealed_credentials,revision FROM ${table} WHERE ${key}=$1 ORDER BY created_at,id`,
        [access.scope.id],
      );
      return {
        canManage: authority.canManage,
        records: result.rows.map((row) => fromRow(row, access, authority)),
      };
    });
  }
  replace(record: ConnectionRecord, event: string): Promise<boolean> {
    const { table, key } = storage(record.access);
    return this.withAccess(
      record.access,
      event === 'provider.connection_tested' ? 'use' : 'manage',
      async (connection) => {
        const result = await connection.query(
          `UPDATE ${table} SET metadata=$3::jsonb,sealed_credentials=$4,updated_at=$5,revision=revision+1 WHERE ${key}=$1 AND id=$2 AND revision=$6 RETURNING id`,
          [
            record.access.scope.id,
            record.metadata.id,
            JSON.stringify(record.metadata),
            record.sealedCredentials,
            new Date(),
            record.revision,
          ],
        );
        if (result.rows.length)
          await this.audit(connection, record.access, record.metadata.id, event);
        return result.rows.length > 0;
      },
    );
  }
  delete(access: ConnectionAccess, id: string): Promise<boolean> {
    const { table, key } = storage(access);
    return this.withAccess(access, 'manage', async (connection) => {
      const result = await connection.query(
        `DELETE FROM ${table} WHERE ${key}=$1 AND id=$2 RETURNING id`,
        [access.scope.id, id],
      );
      if (result.rows.length)
        await this.audit(connection, access, id, 'provider.connection_deleted');
      return result.rows.length > 0;
    });
  }
}
