import type { SqlConnection } from '../auth/postgres-auth-repository.js';

// The operation holds its resource locks and has written its mandatory audit.
// Rejecting admission before COMMIT rolls back that same transaction.
export type TransactionAdmission = (connection: SqlConnection) => Promise<void>;
