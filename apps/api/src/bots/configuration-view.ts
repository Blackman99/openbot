import type { BotConfiguration } from './service.js';

// Current and historical Web/public views share this allowlist. Persisted JSON
// may gain internal fields; those fields must never become response properties.
function bindingView(binding: BotConfiguration['modelBinding']) {
  return {
    scope: { kind: binding.scope.kind, id: binding.scope.id },
    connectionId: binding.connectionId,
    modelId: binding.modelId,
  };
}
export function botConfigurationView(configuration: BotConfiguration): BotConfiguration {
  const { modelBinding, limits } = configuration;
  return {
    name: configuration.name,
    roleDescription: configuration.roleDescription,
    description: configuration.description,
    instructions: configuration.instructions,
    modelBinding: bindingView(modelBinding),
    limits: {
      maxTotalTokens: limits.maxTotalTokens,
      maxDurationSeconds: limits.maxDurationSeconds,
      maxTurns: limits.maxTurns,
      maxDelegationDepth: limits.maxDelegationDepth,
    },
    ...(configuration.avatarObjectId === undefined
      ? {}
      : { avatarObjectId: configuration.avatarObjectId }),
    ...(configuration.retryPolicy
      ? {
          retryPolicy: {
            maxAttemptsPerModel: configuration.retryPolicy.maxAttemptsPerModel,
            maxRunsPerChain: configuration.retryPolicy.maxRunsPerChain,
          },
        }
      : {}),
    ...(configuration.fallbackBindings === undefined
      ? {}
      : { fallbackBindings: configuration.fallbackBindings.map(bindingView) }),
  };
}
