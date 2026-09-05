import { message, conversation, user, workspace } from './conversations.js';
export { message, conversation, user, workspace, token } from './conversations.js';
export { group, membership, grant } from './group-bots.js';
export const memory = {
  id: '1c661304-a1bc-4767-9a87-c47de763f749',
  versionId: '2c661304-a1bc-4767-9a87-c47de763f749',
  version: 1 as const,
  scope: { kind: 'group' as const, workspaceId: workspace.id, groupId: conversation.subject.id },
  creator: { id: user.id, displayName: user.displayName },
  createdAt: message.createdAt,
  confidence: 0.5,
  confidenceSource: 'human' as const,
  text: message.body,
  source: {
    conversationId: conversation.id,
    messageId: message.id,
    eventId: message.versionEventId,
    creationEventId: message.versionEventId,
    creationSequence: message.creationSequence,
    version: message.version,
    author: message.author,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  },
};
export const command = {
  messageId: message.id,
  expectedSourceEventId: message.versionEventId,
  confidence: 0.5,
  idempotencyKey: 'save-memory-key',
};
