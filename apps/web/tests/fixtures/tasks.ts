import { conversation, user, receipt } from './conversations.js';
export { conversation, user, receipt, token, workspace } from './conversations.js';
export const task = {
  id: '10000000-0000-4000-8000-000000000001',
  conversationId: conversation.id,
  status: 'queued' as const,
  createdAt: '2026-09-05T00:00:00.000Z',
  bot: {
    id: '20000000-0000-4000-8000-000000000002',
    name: 'Research Bot',
    versionId: '30000000-0000-4000-8000-000000000003',
    versionNumber: 3,
  },
  executionUser: { id: user.id, displayName: user.displayName },
  groupGrantId: null,
  trigger: receipt,
  runCount: 1,
  olderRunsCursor: null,
  runs: [
    {
      id: '40000000-0000-4000-8000-000000000004',
      attempt: 1,
      status: 'queued' as const,
      createdAt: '2026-09-05T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      provider: null,
      usage: null,
      error: null,
      output: null,
    },
  ],
};
