import { createHash } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import type { ConnectionAccess, ConnectionPermission, ConnectionScope } from './scope.js';
import { ProviderError } from './url-policy.js';

export function providerStorage(scope: ConnectionScope) {
  return scope.kind === 'personal'
    ? { table: 'personal_model_connections', key: 'owner_user_id' }
    : { table: 'workspace_model_connections', key: 'workspace_id' };
}
// Requires an existing transaction. Callers holding a bot/workspace lock acquire that first.
// Namespace739105 serializes all personal provider writes without granting users-row UPDATE rights.
export async function authorizeProviderScope(
  connection: SqlConnection,
  access: ConnectionAccess,
  permission: ConnectionPermission,
) {
  if (access.scope.kind === 'personal') {
    if (access.scope.id !== access.actorUserId) throw new ProviderError('connection_not_found');
    const key = createHash('sha256')
      .update(`openbot:model-scope:${access.scope.id.toLowerCase()}`)
      .digest()
      .readInt32BE(0);
    await connection.query('SELECT pg_advisory_xact_lock($1, $2)', [739105, key]);
    return { canManage: true };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(access.scope.id))
    throw new ProviderError('workspace_forbidden');
  const workspace = await connection.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
    access.scope.id,
  ]);
  if (!workspace.rows[0]) throw new ProviderError('workspace_forbidden');
  const member = await connection.query<{ role: string }>(
    'SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
    [access.scope.id, access.actorUserId],
  );
  if (!member.rows[0]) throw new ProviderError('workspace_forbidden');
  const canManage = ['owner', 'administrator'].includes(member.rows[0].role);
  if (permission === 'manage' && !canManage) throw new ProviderError('workspace_forbidden');
  return { canManage };
}
