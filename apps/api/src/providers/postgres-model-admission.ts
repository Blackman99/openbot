import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import {
  currentPolicy,
  policyDetails,
  type CapabilityRecord,
  type ModelPolicy,
} from './capability-policy.js';
import { capabilityExclusion } from './fallback-policy.js';
import { authorizeProviderScope, providerStorage } from './postgres-provider-scope.js';
import type { ConnectionAccess } from './scope.js';
import { ProviderError } from './url-policy.js';
import type { ConnectionMetadata } from './connections.js';
import { credentialContext } from './scope.js';

// Internal admission for a durable model binding, not a resolution-preview snapshot.
// The caller owns BEGIN/COMMIT/ROLLBACK and must acquire its workspace lock first.
// This scope lock stays held until that same transaction commits its dependent write.
// Every provider policy/configuration writer acquires the same lock before changing state.
export async function admitUsableModel(
  connection: SqlConnection,
  access: ConnectionAccess,
  expected: { connectionId: string; expectedModelId: string },
) {
  const authority = await authorizeProviderScope(connection, access, 'use');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(expected.connectionId)
  )
    throw new ProviderError('connection_not_found');
  const { table, key } = providerStorage(access.scope);
  const result = await connection.query<Omit<CapabilityRecord, 'canManage'>>(
    `SELECT metadata,revision,policy FROM ${table} WHERE ${key}=$1 AND id=$2`,
    [access.scope.id, expected.connectionId],
  );
  const row = result.rows[0];
  if (!row) throw new ProviderError('connection_not_found');
  const record = { ...row, policy: currentPolicy(row.policy), canManage: authority.canManage };
  const reason = capabilityExclusion(record, 'basic');
  if (reason)
    throw new ProviderError(
      reason === 'disabled' ? 'connection_disabled' : 'model_capability_required',
    );
  if (record.metadata.modelId !== expected.expectedModelId)
    throw new ProviderError('model_binding_changed');
  return {
    scope: { ...access.scope, id: access.scope.id.toLowerCase() },
    connectionId: record.metadata.id,
    modelId: record.metadata.modelId,
    chatOnly: !policyDetails(record).collaboration,
  };
}

// Worker-only credential snapshot under the same provider scope lock. Ordinary
// consumers continue using admitUsableModel's safe DTO; no endpoint returns this.
export async function admitExecutionModel(
  connection: SqlConnection,
  access: ConnectionAccess,
  expected: { connectionId: string; expectedModelId: string },
) {
  const admitted = await admitUsableModel(connection, access, expected);
  const { table, key } = providerStorage(admitted.scope);
  const row = (
    await connection.query<{
      metadata: ConnectionMetadata;
      revision: number;
      sealed_credentials: string;
      policy: ModelPolicy | null;
    }>(
      `SELECT metadata,revision,sealed_credentials,policy FROM ${table} WHERE ${key}=$1 AND id=$2`,
      [admitted.scope.id, admitted.connectionId],
    )
  ).rows[0];
  if (!row) throw new ProviderError('connection_not_found');
  return {
    scope: admitted.scope,
    connectionId: admitted.connectionId,
    revision: row.revision,
    protocol: row.metadata.protocol,
    modelId: row.metadata.modelId,
    baseUrl: row.metadata.baseUrl,
    anthropicVersion: row.metadata.anthropicVersion,
    sealedCredentials: row.sealed_credentials,
    credentialContext: credentialContext(admitted.scope, admitted.connectionId),
    supportsActions:
      policyDetails({
        metadata: row.metadata,
        revision: row.revision,
        policy: currentPolicy(row.policy ?? undefined),
        canManage: false,
      }).flags.toolCalling.status === 'supported',
  };
}
