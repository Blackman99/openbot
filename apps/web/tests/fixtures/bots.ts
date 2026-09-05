export const token = 'a'.repeat(43);
export const user = {
  id: 'ab661304-a1bc-4767-9a87-c47de763f749',
  email: 'ada@example.com',
  displayName: 'Ada',
};
export const workspace = {
  id: 'ae661304-a1bc-4767-9a87-c47de763f749',
  name: 'Team',
  description: '',
  role: 'member' as const,
};
export const input = {
  name: 'Researcher',
  roleDescription: 'Research assistant',
  description: 'Find useful evidence',
  instructions: '\nCite sources.\n  Preserve uncertainty.\n',
  modelBinding: {
    scope: { kind: 'workspace' as const, id: workspace.id },
    connectionId: 'ce661304-a1bc-4767-9a87-c47de763f749',
    modelId: 'basic-model',
  },
  limits: { maxTotalTokens: 32768, maxDurationSeconds: 300, maxTurns: 8, maxDelegationDepth: 2 },
};
export const summary = {
  id: 'bdcc0832-ce23-4d77-9c72-fb4e9d01766c',
  workspaceId: workspace.id,
  visibility: 'private' as const,
  accessRole: 'owner' as const,
  name: input.name,
  roleDescription: input.roleDescription,
  description: input.description,
  bindingStatus: { state: 'ready' as const, chatOnly: true },
};
export const bot = {
  ...summary,
  currentVersion: {
    id: 'ddcc0832-ce23-4d77-9c72-fb4e9d01766c',
    number: 1,
    author: { id: user.id, displayName: user.displayName },
    createdAt: '2026-09-05T00:00:00.000Z',
    rationale: 'Created',
    configuration: input,
  },
};
