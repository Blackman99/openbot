import type { ReadinessChecks, ReadinessProbe } from '../readiness.js';

export interface DatabaseQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  rows: Row[];
}

export interface DatabaseClient {
  query(statement: string, parameters?: unknown[]): Promise<DatabaseQueryResult>;
}

export class PostgresReadinessProbe implements ReadinessProbe {
  constructor(
    private readonly database: DatabaseClient,
    private readonly expectedMigrationVersions: readonly string[],
  ) {}

  async check(): Promise<ReadinessChecks> {
    try {
      await this.database.query('SELECT 1');
    } catch {
      return { database: 'unavailable', migrations: 'unknown' };
    }

    try {
      const result = await this.database.query(
        'SELECT version FROM openbot_schema_migrations ORDER BY applied_at, version',
      );
      const isExactLedger =
        result.rows.length === this.expectedMigrationVersions.length &&
        result.rows.every(
          ({ version }, index) => version === this.expectedMigrationVersions[index],
        );
      const migrations = isExactLedger ? 'current' : 'stale';

      return { database: 'ready', migrations };
    } catch {
      return { database: 'ready', migrations: 'stale' };
    }
  }
}
