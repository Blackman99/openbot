import { workspace } from './bots.js';

export const teamTemplate = {
  schemaVersion: 'openbot.team-template.v1',
  identity: { name: 'Research desk', description: 'Find then write' },
  bots: [
    {
      key: 'researcher',
      template: {
        schemaVersion: 'openbot.bot-template.v1',
        identity: {
          name: 'Researcher',
          roleDescription: 'Researcher',
          description: 'Finds sources',
        },
        instructions: 'Cite every claim.',
        capabilities: { required: 'basic' },
        collaboration: { visibility: 'workspace' },
        budgets: {
          maxTotalTokens: 32768,
          maxDurationSeconds: 300,
          maxTurns: 8,
          maxDelegationDepth: 2,
        },
      },
    },
  ],
  roles: [{ botKey: 'researcher', role: 'Researcher' }],
  defaultLead: { botKey: 'researcher' },
  collaboration: { maxConcurrentRuns: 4 },
  budgets: { maxDurationSeconds: 300, maxTurns: 8, maxDelegationDepth: 2 },
};

export const teamPreview = {
  template: teamTemplate,
  objects: [
    { kind: 'group', name: 'Research desk', description: 'Find then write' },
    {
      kind: 'bot',
      key: 'researcher',
      name: 'Researcher',
      role: 'Researcher',
      requiredCapability: 'basic',
    },
    { kind: 'membership', botKey: 'researcher', role: 'Researcher' },
    { kind: 'collaboration', maxConcurrentRuns: 4 },
    { kind: 'budgets', maxDurationSeconds: 300, maxTurns: 8, maxDelegationDepth: 2 },
    { kind: 'defaultLead', botKey: 'researcher' },
  ],
  mappings: [{ botKey: 'researcher', requiredCapability: 'basic', bound: false }],
  acknowledgements: [
    { id: 'create-bots', required: true as const, accepted: false },
    { id: 'create-memberships', required: true as const, accepted: false },
    { id: 'create-group-configuration', required: true as const, accepted: false },
    { id: 'no-source-access', required: true as const, accepted: false },
  ],
  unresolved: true,
};

export const importedTeam = { id: 'imported-group', workspaceId: workspace.id };
