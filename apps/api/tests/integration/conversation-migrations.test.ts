import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS, migrateDatabase } from '../../src/database/migrations.js';

describe('conversation migration safety', () => {
  it('does not record the ledger migration when its mandatory native immutable guard fails', async () => {
    const statements: string[] = [];
    const connection = {
      query: async (statement: string) => {
        statements.push(statement);
        if (statement.includes('CREATE FUNCTION reject_conversation_event_mutation'))
          throw new Error('ledger guard installation failed');
        return statement.startsWith('SELECT version FROM openbot_schema_migrations')
          ? {
              rows: MIGRATION_VERSIONS.slice(
                0,
                MIGRATION_VERSIONS.indexOf('0014_conversation_ledger'),
              ).map((version) => ({ version })),
            }
          : { rows: [] };
      },
      release: () => undefined,
    };
    await expect(migrateDatabase({ connect: async () => connection })).rejects.toThrow(
      'ledger guard installation failed',
    );
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(
      statements.some((statement) => statement.startsWith('INSERT INTO openbot_schema_migrations')),
    ).toBe(false);
  });
});
