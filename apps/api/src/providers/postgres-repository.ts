import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../auth/postgres-auth-repository.js';
import type { ConnectionMetadata, ConnectionRecord, ProviderRepository } from './connections.js';

type Row = {
  owner_user_id: string;
  metadata: ConnectionMetadata;
  sealed_credentials: string;
  revision: number;
};
function fromRow(row: Row): ConnectionRecord {
  return {
    ownerId: row.owner_user_id,
    metadata: row.metadata,
    sealedCredentials: row.sealed_credentials,
    revision: row.revision,
  };
}

export class PostgresProviderRepository implements ProviderRepository {
  constructor(private readonly pool: SqlPool) {}

  async insert(record: ConnectionRecord): Promise<void> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const now = new Date();
      await connection.query(
        'INSERT INTO personal_model_connections (id,owner_user_id,metadata,sealed_credentials,created_at,updated_at) VALUES ($1,$2,$3::jsonb,$4,$5,$5)',
        [
          record.metadata.id,
          record.ownerId,
          JSON.stringify(record.metadata),
          record.sealedCredentials,
          now,
        ],
      );
      await connection.query(
        'INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,$2,$3,$4,$5::jsonb)',
        [
          randomUUID(),
          'provider.connection_created',
          record.ownerId,
          now,
          JSON.stringify({ connectionId: record.metadata.id }),
        ],
      );
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async find(ownerId: string, id: string): Promise<ConnectionRecord | undefined> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id))
      return undefined;
    const connection = await this.pool.connect();
    try {
      const result = await connection.query<Row>(
        'SELECT owner_user_id,metadata,sealed_credentials,revision FROM personal_model_connections WHERE owner_user_id=$1 AND id=$2',
        [ownerId, id],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    } finally {
      connection.release();
    }
  }

  async list(ownerId: string): Promise<ConnectionRecord[]> {
    const connection = await this.pool.connect();
    try {
      const result = await connection.query<Row>(
        'SELECT owner_user_id,metadata,sealed_credentials,revision FROM personal_model_connections WHERE owner_user_id=$1 ORDER BY created_at,id',
        [ownerId],
      );
      return result.rows.map(fromRow);
    } finally {
      connection.release();
    }
  }

  async replace(record: ConnectionRecord, event: string): Promise<boolean> {
    return this.mutate(
      record.ownerId,
      record.metadata.id,
      event,
      'UPDATE personal_model_connections SET metadata=$3::jsonb,sealed_credentials=$4,updated_at=$5,revision=revision+1 WHERE owner_user_id=$1 AND id=$2 AND revision=$6 RETURNING id',
      [JSON.stringify(record.metadata), record.sealedCredentials, new Date(), record.revision],
    );
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    return this.mutate(
      ownerId,
      id,
      'provider.connection_deleted',
      'DELETE FROM personal_model_connections WHERE owner_user_id=$1 AND id=$2 RETURNING id',
      [],
    );
  }

  private async mutate(
    ownerId: string,
    id: string,
    event: string,
    statement: string,
    parameters: unknown[],
  ): Promise<boolean> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await connection.query(statement, [ownerId, id, ...parameters]);
      if (result.rows.length)
        await connection.query(
          'INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,$2,$3,$4,$5::jsonb)',
          [randomUUID(), event, ownerId, new Date(), JSON.stringify({ connectionId: id })],
        );
      await connection.query('COMMIT');
      return result.rows.length > 0;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}
