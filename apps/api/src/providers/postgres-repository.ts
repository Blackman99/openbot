import { authorizeProviderScope, providerStorage } from './postgres-provider-scope.js';
import { validateFallbacks } from './fallback-policy.js';
import { currentPolicy, type ModelPolicy } from './capability-policy.js';
import type { PolicyChange } from './policy-input.js';
import { randomUUID } from 'node:crypto';
import type { SqlPool, SqlConnection } from '../auth/postgres-auth-repository.js';
import type { ConnectionMetadata, ConnectionRecord, ProviderRepository } from './connections.js';
import type { ConnectionAccess, ConnectionAuthority, ConnectionPermission } from './scope.js';
import { ProviderError } from './url-policy.js';

type Row = {
  policy?: ModelPolicy;
  metadata: ConnectionMetadata;
  sealed_credentials: string;
  revision: number;
};
const storage = (access: ConnectionAccess) => providerStorage(access.scope);

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
    policy: currentPolicy(row.policy),
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
      const authority = await authorizeProviderScope(connection, access, permission);
      const result = await operation(connection, authority);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  private audit(
    connection: SqlConnection,
    access: ConnectionAccess,
    id: string,
    event: string,
    detail: Record<string, unknown> = {},
  ) {
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
          ...detail,
        }),
      ],
    );
  }
  async insert(record: ConnectionRecord): Promise<void> {
    const { table, key } = storage(record.access);
    await this.withAccess(record.access, 'manage', async (connection) => {
      await connection.query(
        `INSERT INTO ${table}(id,${key},metadata,sealed_credentials,created_at,updated_at,policy) VALUES($1,$2,$3::jsonb,$4,$5,$5,$6::jsonb)`,
        [
          record.metadata.id,
          record.access.scope.id,
          JSON.stringify(record.metadata),
          record.sealedCredentials,
          new Date(),
          JSON.stringify(currentPolicy(record.policy)),
        ],
      );
      await this.audit(
        connection,
        record.access,
        record.metadata.id,
        'provider.connection_created',
        { policyAfter: currentPolicy(record.policy) },
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
        `SELECT metadata,sealed_credentials,revision,policy FROM ${table} WHERE ${key}=$1 AND id=$2`,
        [access.scope.id, id],
      );
      return result.rows[0] ? fromRow(result.rows[0], access, authority) : undefined;
    });
  }
  list(access: ConnectionAccess): Promise<{ canManage: boolean; records: ConnectionRecord[] }> {
    const { table, key } = storage(access);
    return this.withAccess(access, 'read', async (connection, authority) => {
      const result = await connection.query<Row>(
        `SELECT metadata,sealed_credentials,revision,policy FROM ${table} WHERE ${key}=$1 ORDER BY created_at,id`,
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
        const previous = await connection.query<{ policy?: ModelPolicy }>(
          `SELECT policy FROM ${table} WHERE ${key}=$1 AND id=$2 AND revision=$3`,
          [record.access.scope.id, record.metadata.id, record.revision],
        );
        if (!previous.rows[0]) return false;
        return this.writeRecord(connection, record, event, currentPolicy(previous.rows[0].policy));
      },
    );
  }
  private async writeRecord(
    connection: SqlConnection,
    record: ConnectionRecord,
    event: string,
    previousPolicy: ModelPolicy,
  ): Promise<boolean> {
    const { table, key } = storage(record.access);
    const result = await connection.query(
      `UPDATE ${table} SET metadata=$3::jsonb,sealed_credentials=$4,updated_at=$5,revision=revision+1,policy=$7::jsonb WHERE ${key}=$1 AND id=$2 AND revision=$6 RETURNING id`,
      [
        record.access.scope.id,
        record.metadata.id,
        JSON.stringify(record.metadata),
        record.sealedCredentials,
        new Date(),
        record.revision,
        JSON.stringify(currentPolicy(record.policy)),
      ],
    );
    if (result.rows.length)
      await this.audit(connection, record.access, record.metadata.id, event, {
        revisionBefore: record.revision,
        revisionAfter: record.revision + 1,
        policyBefore: previousPolicy,
        policyAfter: currentPolicy(record.policy),
      });
    return result.rows.length > 0;
  }
  changePolicy(
    access: ConnectionAccess,
    id: string,
    expectedRevision: number,
    change: PolicyChange,
  ): Promise<ConnectionRecord> {
    const { table, key } = storage(access);
    return this.withAccess(access, 'manage', async (connection, authority) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id))
        throw new ProviderError('connection_not_found');
      const found = await connection.query<Row>(
        `SELECT metadata,sealed_credentials,revision,policy FROM ${table} WHERE ${key}=$1 AND id=$2`,
        [access.scope.id, id],
      );
      if (!found.rows[0]) throw new ProviderError('connection_not_found');
      const record = fromRow(found.rows[0], access, authority);
      if (record.revision !== expectedRevision) throw new ProviderError('connection_conflict');
      const before = currentPolicy(record.policy);
      if (change.kind === 'override') {
        record.policy = {
          ...before,
          overrides: {
            ...before.overrides,
            [change.capability]: {
              value: change.value,
              rationale: change.rationale,
              createdAt: change.createdAt,
              actorUserId: access.actorUserId,
              generation: before.generation,
            },
          },
        };
      } else {
        const graph = await connection.query<Row>(
          `SELECT metadata,sealed_credentials,revision,policy FROM ${table} WHERE ${key}=$1 ORDER BY id`,
          [access.scope.id],
        );
        validateFallbacks(
          graph.rows.map((row) => fromRow(row, access, authority)),
          record.metadata.id.toLowerCase(),
          change.requiredCapability,
          change.connectionIds,
        );
        record.policy = {
          ...before,
          fallbacks: {
            requiredCapability: change.requiredCapability,
            connectionIds: change.connectionIds,
          },
        };
      }
      const event =
        change.kind === 'override'
          ? 'provider.capability_overridden'
          : 'provider.fallbacks_updated';
      if (!(await this.writeRecord(connection, record, event, before)))
        throw new ProviderError('connection_conflict');
      return { ...record, revision: record.revision + 1 };
    });
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
