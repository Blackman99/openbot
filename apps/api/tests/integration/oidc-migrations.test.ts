import { newMemDatabase } from '../helpers/provider-database.js';
import { expect, it } from 'vitest';
import { migrateDatabase } from '../../src/database/migrations.js';
it('installs issuer/subject identities and expiring browser-bound OIDC transactions', async () => {
  const pool = new (newMemDatabase().adapters.createPg().Pool)();
  try {
    await migrateDatabase(pool, { installPostgresGuards: false });
    expect((await pool.query('SELECT * FROM oidc_identities')).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM oidc_transactions')).rows).toEqual([]);
  } finally {
    await pool.end();
  }
});
