import { bot, input, workspace } from './bots.js';

export const template = {
  schemaVersion: 'openbot.bot-template.v1' as const,
  identity: {
    name: 'Helper',
    roleDescription: 'Researcher',
    description: 'Notes',
  },
  instructions: 'Answer with cited sources.\n  Keep spaces.',
  capabilities: { required: 'basic' as const },
  collaboration: { visibility: 'private' as const },
  budgets: input.limits,
};

export const preview = {
  template,
  differences: [
    { field: 'identity.name', template: 'Helper', local: bot.name },
    { field: 'instructions', template: template.instructions, local: input.instructions },
  ],
};

export const imported = {
  ...bot,
  id: 'cdcc0832-ce23-4d77-9c72-fb4e9d01766c',
  name: template.identity.name,
  roleDescription: template.identity.roleDescription,
  description: template.identity.description,
  currentVersion: {
    ...bot.currentVersion,
    id: 'edcc0832-ce23-4d77-9c72-fb4e9d01766c',
    configuration: {
      ...input,
      name: template.identity.name,
      roleDescription: template.identity.roleDescription,
      description: template.identity.description,
      instructions: template.instructions,
    },
  },
};

export const model = {
  scope: { kind: 'workspace' as const, id: workspace.id },
  connectionId: input.modelBinding.connectionId,
  modelId: input.modelBinding.modelId,
  name: 'Team Basic',
  enabled: true,
  basic: true,
  collaboration: false,
  visionInput: false,
  available: true,
};
