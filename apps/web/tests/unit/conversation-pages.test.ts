import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ListPage from '../../src/routes/app/workspaces/[workspaceId]/conversations/+page.svelte';
import ConversationPage from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/+page.svelte';
import VersionsPage from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/messages/[messageId]/versions/+page.svelte';
import AppPage from '../../src/routes/app/+page.svelte';
import {
  conversation,
  message,
  page,
  user,
  version,
  workspace,
} from '../fixtures/conversations.js';
const base = { user, workspace, workspaces: [workspace] };
const data = {
  ...base,
  ...page,
  cursor: null,
  limit: 30,
  commands: {
    append: 'new-message-key',
    messages: { [message.id]: { edit: 'edit-message-key', tombstone: 'delete-message-key' } },
  },
};
const params = { workspaceId: workspace.id, conversationId: conversation.id };
describe('Conversation pages', () => {
  it('labels pinned Bot replies and links the conversation to durable Tasks', () => {
    const html = render(ConversationPage, {
      props: {
        data: {
          ...data,
          messages: [
            {
              ...message,
              author: {
                kind: 'bot',
                id: '90000000-0000-4000-8000-000000000009',
                displayName: 'Research Bot',
                versionId: '91000000-0000-4000-8000-000000000009',
                versionNumber: 3,
              },
              canEdit: false,
              canDelete: false,
              canAudit: false,
            },
          ],
        },
        form: null,
        params,
      },
    }).body;
    expect(html).toContain('Bot · configuration version 3');
    expect(html).toContain(`/conversations/${conversation.id}/tasks`);
    expect(html).not.toContain('Edit message');
    expect(html).not.toContain('View versions');
  });

  it('opens explicit subjects through a POST form and exposes workspace navigation', () => {
    const html = render(ListPage, {
      props: {
        data: { ...base, subjects: [{ ...conversation.subject, name: 'Research group' }] },
        form: null,
        params,
      },
    }).body;
    expect(html).toContain('Open Research group');
    expect(html).toContain('method="POST"');
    expect(html).not.toContain('Run task');
    expect(render(AppPage, { props: { data: base } }).body).toContain(
      `/workspaces/${workspace.id}/conversations`,
    );
  });
  it('renders current messages, permission controls, stable form keys and opaque next-page links', () => {
    const html = render(ConversationPage, { props: { data, form: null, params } }).body;
    expect(html).toContain('First message.');
    expect(html).toContain('Edit message');
    expect(html).toContain('Delete message');
    expect(html).toContain('View versions');
    expect(html).toContain('value="new-message-key"');
    expect(html).toContain('value="edit-message-key"');
    expect(html).toContain('opaque_cursor-1');
    expect(html).toContain('Refresh messages');
  });
  it('preserves a failed edit key, old precondition and draft while blocking conflict resubmission', () => {
    const html = render(ConversationPage, {
      props: {
        data: { ...data, messages: [{ ...message, version: 2, body: 'Server changed' }] },
        form: {
          action: 'edit',
          values: {
            messageId: message.id,
            idempotencyKey: 'failed-edit-key',
            expectedVersion: '1',
            body: 'My retained draft',
          },
          conflict: true,
          error: 'Refresh the latest version',
        },
        params,
      },
    }).body;
    expect(html).toContain('failed-edit-key');
    expect(html).toContain('My retained draft');
    expect(html).toContain('name="expectedVersion" value="1"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save edit<\/button>/u);
  });
  it('hides protected controls and tombstoned bodies from ordinary current-page readers', () => {
    const html = render(ConversationPage, {
      props: {
        data: {
          ...data,
          canWrite: false,
          messages: [
            {
              ...message,
              body: null,
              reason: 'Removed by moderator',
              deleted: true,
              canEdit: false,
              canDelete: false,
              canAudit: false,
            },
          ],
        },
        form: null,
        params,
      },
    }).body;
    expect(html).toContain('Deleted message');
    expect(html).toContain('Removed by moderator');
    for (const text of [
      'First message.',
      'Edit message',
      'Delete message',
      'View versions',
      'Send message',
    ])
      expect(html).not.toContain(text);
  });
  it('escapes current message text and renders authorized versions in a separate page', () => {
    const html = render(ConversationPage, {
      props: {
        data: { ...data, messages: [{ ...message, body: '<script>private()</script>' }] },
        form: null,
        params,
      },
    }).body;
    expect(html).toContain('&lt;script>private()&lt;/script>');
    expect(html).not.toContain('<script>private()');
    const versions = render(VersionsPage, {
      props: {
        data: {
          ...base,
          conversationId: conversation.id,
          messageId: message.id,
          versions: [version],
        },
        params: { ...params, messageId: message.id },
        form: null,
      },
    }).body;
    expect(versions).toContain('Version 1');
    expect(versions).toContain('First message.');
    expect(versions).toContain('Ada');
  });
});
