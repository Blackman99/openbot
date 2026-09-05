import type { BotConfiguration } from './service.js';

// Current and historical Web/public views share this allowlist. Persisted JSON
// may gain internal fields; those fields must never become response properties.
export function botConfigurationView(configuration: BotConfiguration): BotConfiguration {
  const { modelBinding, limits } = configuration;
  return {
    name: configuration.name,
    roleDescription: configuration.roleDescription,
    description: configuration.description,
    instructions: configuration.instructions,
    modelBinding: {
      scope: { kind: modelBinding.scope.kind, id: modelBinding.scope.id },
      connectionId: modelBinding.connectionId,
      modelId: modelBinding.modelId,
    },
    limits: {
      maxTotalTokens: limits.maxTotalTokens,
      maxDurationSeconds: limits.maxDurationSeconds,
      maxTurns: limits.maxTurns,
      maxDelegationDepth: limits.maxDelegationDepth,
    },
    ...(configuration.avatarObjectId === undefined
      ? {}
      : { avatarObjectId: configuration.avatarObjectId }),
  };
}
