import { DataType, newDb } from 'pg-mem';
export function newProviderDatabase() {
  const database = newDb({ noAstCoverageCheck: true });
  // pg-mem checks authorization/query behavior only. PostgreSQL runtime tests prove lock ordering.
  database.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: () => 0,
  });
  return database;
}
