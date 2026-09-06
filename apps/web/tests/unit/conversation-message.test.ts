import { describe, expect, it } from 'vitest';
import { parseConversationMessage } from '../../src/lib/conversation-message.js';
import { message } from '../fixtures/conversations.js';

describe('current message locator projection shared with the browser', () => {
  it('validates the authorized current projection before a stream reference can be acknowledged', () => {
    expect(parseConversationMessage(message)).toEqual(message);
    expect(parseConversationMessage({ ...message, body: undefined })).toBeUndefined();
    expect(
      parseConversationMessage({ ...message, claimToken: 'never-client-data' }),
    ).toBeUndefined();
    expect(
      parseConversationMessage({ ...message, deleted: true, body: message.body }),
    ).toBeUndefined();
    expect(
      parseConversationMessage({
        ...message,
        deleted: true,
        body: null,
        reason: 'Deleted by author',
        canEdit: false,
        canDelete: false,
      }),
    ).toMatchObject({ deleted: true, body: null });
  });
});
