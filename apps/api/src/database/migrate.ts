import pg from 'pg';

import { readDatabaseConfig } from '../config.js';
import { migrateDatabase } from './migrations.js';

const { Pool } = pg;

async function main(): Promise<void> {
  const pool = new Pool(readDatabaseConfig(process.env));
  try {
    await migrateDatabase(pool);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown migration failure';
  console.error(`Migration failed: ${message}`);
  process.exitCode = 1;
}
