import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ListPage from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/tasks/+page.svelte';
import DetailPage from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/tasks/[taskId]/+page.svelte';
import ConversationPage from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/+page.svelte';
import { task } from '../fixtures/tasks.js';
import { conversation, page, message, workspace, user } from '../fixtures/conversations.js';
import { decision, lead } from '../fixtures/routing.js';
import type { TaskView } from '../../src/lib/server/task-api.js';

const routed = {
  ...task,
  bot: { ...task.bot, id: lead.botId, versionId: lead.versionId, name: lead.name },
  groupGrantId: lead.grantId,
  routing: { algorithm: decision.algorithm, reason: decision.reason },
};
const base = { conversation, workspace, user, workspaces: [workspace], canWrite: true };
const params = { workspaceId: workspace.id, conversationId: conversation.id };
describe('Group routing integrated UI', () => {
  it('offers an automatic default and labels the optional explicit grant as a mention', () => {
    const data = {
      ...base,
      canSubmit: true,
      grants: [{ id: lead.grantId, name: lead.name }],
      tasks: [routed],
      cursor: null,
      limit: 20,
      nextCursor: null,
      idempotencyKey: 'automatic-command',
    };
    const html = render(ListPage, { props: { data, form: null, params } }).body;
    expect(html).toContain('Mention a Bot');
    expect(html).toContain('Automatic · default or local match');
    expect(html).toContain(`@ ${lead.name}`);
    expect(html).not.toMatch(/<select[^>]*required/u);
    expect(html).toContain(`?routingTaskId=${task.id}#routing-${task.id}`);
    expect(html).toContain('Local term match');
  });

  it('shows full saved candidate evidence on Task detail with a conversation evidence link', () => {
    const html = render(DetailPage, {
      props: {
        data: {
          ...base,
          task: routed,
          routingDecision: decision,
          canRetry: false,
          idempotencyKey: 'unused-retry-key',
        },
        params: { ...params, taskId: task.id },
        form: null,
      },
    }).body;
    expect(html).toContain('Candidate evidence (2)');
    expect(html).toContain('Lexical score: 5');
    expect(html).toContain('evidence, research');
    expect(html).toContain(`?routingTaskId=${task.id}#routing-${task.id}`);
  });

  it('keeps original routing evidence beside retry and bounded history for the failed current attempt', () => {
    const failed: TaskView = {
      ...routed,
      status: 'failed',
      runCount: 2,
      olderRunsCursor: 'older_attempt',
      runs: [
        {
          ...task.runs[0]!,
          attempt: 2,
          status: 'failed',
          finishedAt: '2026-09-05T00:00:01.000Z',
          error: 'provider_failed',
        },
      ],
    };
    const html = render(DetailPage, {
      props: {
        data: {
          ...base,
          task: failed,
          routingDecision: decision,
          canRetry: true,
          idempotencyKey: 'routed-retry-key',
        },
        params: { ...params, taskId: task.id },
        form: null,
      },
    }).body;
    expect(html.match(/Candidate evidence \(2\)/gu)).toHaveLength(1);
    expect(html).toContain('Current attempt 2 of 2');
    expect(html).toContain('/runs?cursor=older_attempt');
    expect(html).toContain('Retry failed task');
    expect(html).toContain(`name="expectedRunId" value="${failed.runs[0]!.id}"`);
    expect(html).toContain('routed-retry-key');
  });

  it('renders one selected Task decision within the current conversation and retains message content', () => {
    const data = {
      ...base,
      ...page,
      attachmentMaximum: 10485760,
      cursor: null,
      limit: 30,
      commands: {
        append: 'new-message-key',
        messages: {
          [message.id]: { edit: 'edit-key', tombstone: 'delete-key', saveMemory: 'memory-key' },
        },
      },
      selectedRouting: { task: routed, decision },
    };
    const html = render(ConversationPage, { props: { data, params, form: null } }).body;
    expect(html).toContain(`id="routing-${task.id}"`);
    expect(html).toContain('Lead: Researcher');
    expect(html).toContain('Candidate evidence (2)');
    expect(html).toContain('First message.');
    expect(html).toContain('Routing settings');
    expect(html).not.toContain('modelBinding');
  });
});
