import { summary, user, workspace } from './bots.js';
export { token, user, workspace, summary } from './bots.js';
export const group = {
  id: 'ec661304-a1bc-4767-9a87-c47de763f749',
  workspaceId: workspace.id,
  name: 'Research group',
  description: '',
  visibility: 'private' as const,
  role: 'owner' as const,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};
export const grant = {
  id: 'adcc0832-ce23-4d77-9c72-fb4e9d01766c',
  groupId: group.id,
  conversationId: 'edcc0832-ce23-4d77-9c72-fb4e9d01766c',
  bot: {
    lifecycleState: 'active' as const,
    id: summary.id,
    name: summary.name,
    roleDescription: summary.roleDescription,
    description: summary.description,
    canInspect: true,
  },
  grantedBy: { id: user.id, displayName: user.displayName },
  history: { mode: 'future-only' as const, lowerBound: 4 },
  joined: { eventId: 'fdcc0832-ce23-4d77-9c72-fb4e9d01766c', sequence: 4, at: group.createdAt },
  closed: null,
};
export const membership = {
  groupId: group.id,
  grants: [grant],
  activeCount: 1,
  maxActive: 8 as const,
  canManage: true,
};
