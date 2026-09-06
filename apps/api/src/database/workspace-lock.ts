import { createHash } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';

// Namespace 739106 serializes workspace-row authority through the heavyweight
// lock manager. A plain FOR UPDATE waiter can sleep on the holder's transactionid
// after xmax is set; when that transaction commits the row is free and a new
// acquirer (the next public Bot create) can snatch it ahead of the xid waiter
// (a queued token revoker). Advisory xact locks are granted by ProcLockWakeup,
// so the queued revoker stays ahead of resource admission.
export async function lockWorkspaceAuthority(
  connection: SqlConnection,
  workspaceId: string,
): Promise<boolean> {
  const key = createHash('sha256')
    .update(`openbot:workspace-authority:${workspaceId.toLowerCase()}`)
    .digest()
    .readInt32BE(0);
  await connection.query('SELECT pg_advisory_xact_lock($1, $2)', [739106, key]);
  const workspace = await connection.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [
    workspaceId,
  ]);
  return Boolean(workspace.rows[0]);
}
