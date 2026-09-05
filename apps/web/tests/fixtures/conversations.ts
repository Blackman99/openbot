import { user, workspace } from './bots.js';
export { user, workspace, token, bot } from './bots.js';
export const conversation = {
  id: 'dc661304-a1bc-4767-9a87-c47de763f749',
  workspaceId: workspace.id,
  subject: { kind: 'group' as const, id: 'ec661304-a1bc-4767-9a87-c47de763f749' },
  createdAt: '2026-09-05T00:00:00.000Z',
};
export const message = {
  id: 'fc661304-a1bc-4767-9a87-c47de763f749',
  creationSequence: 1,
  versionEventId: 'ac661304-a1bc-4767-9a87-c47de763f749',
  sequence: 1,
  version: 1,
  author: { id: user.id, displayName: user.displayName },
  body: '\nFirst message.\n  Preserve this.',
  reason: null,
  deleted: false,
  createdAt: conversation.createdAt,
  updatedAt: conversation.createdAt,
  canEdit: true,
  canDelete: true,
  canAudit: true,
};
export const page = {
  conversation,
  messages: [message],
  nextCursor: 'opaque_cursor-1',
  canWrite: true,
};
export const receipt = { messageId: message.id, eventId: message.versionEventId, sequence: 1 };
export const version = {
  id: message.versionEventId,
  sequence: 1,
  type: 'message.created' as const,
  version: 1,
  actor: message.author,
  occurredAt: message.createdAt,
  body: message.body,
  reason: null,
};
