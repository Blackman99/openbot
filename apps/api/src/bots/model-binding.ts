import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { admitUsableModel } from '../providers/postgres-model-admission.js';
import { ProviderError } from '../providers/url-policy.js';
import {
  BotModelError,
  type BindingUnavailableReason,
  type BotBinding,
  type BotConfiguration,
} from './service.js';

export async function admitBotModel(
  connection: SqlConnection,
  actorUserId: string,
  workspaceId: string,
  binding: BotBinding,
) {
  if (binding.scope.kind === 'workspace' && binding.scope.id !== workspaceId)
    throw new BotModelError('not-accessible');
  try {
    return await admitUsableModel(
      connection,
      { actorUserId, scope: binding.scope },
      { connectionId: binding.connectionId, expectedModelId: binding.modelId },
    );
  } catch (error) {
    const reasons: Record<string, BindingUnavailableReason> = {
      connection_not_found: 'not-accessible',
      workspace_forbidden: 'not-accessible',
      connection_disabled: 'disabled',
      model_capability_required: 'capability-unavailable',
      model_binding_changed: 'binding-changed',
    };
    const reason = error instanceof ProviderError ? reasons[error.code] : undefined;
    if (reason) throw new BotModelError(reason);
    throw error;
  }
}
export async function admitConfiguredBindings(
  connection: SqlConnection,
  actorUserId: string,
  workspaceId: string,
  configuration: BotConfiguration,
) {
  const admitted = await admitBotModel(
    connection,
    actorUserId,
    workspaceId,
    configuration.modelBinding,
  );
  for (const binding of configuration.fallbackBindings ?? [])
    await admitBotModel(connection, actorUserId, workspaceId, binding);
  return admitted;
}
