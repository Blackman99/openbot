import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ListPage from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/tasks/+page.svelte';
import DetailPage from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/tasks/[taskId]/+page.svelte';
import RunsPage from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/tasks/[taskId]/runs/+page.svelte';
import { task, conversation, workspace, user } from '../fixtures/tasks.js';
import { grant } from '../fixtures/group-bots.js';
import type { TaskView } from '../../src/lib/server/task-api.js';
const base = {
  conversation,
  workspace,
  user,
  workspaces: [workspace],
  canWrite: true,
  canCancel: false,
  canConfirmCancellation: false,
  canPause: false,
  canConfirmPause: false,
  canResume: false,
  canConfirmResume: false,
  partialOutput: null,
  partialUnavailable: false,
};
const data = {
  ...base,
  canSubmit: true,
  grants: [{ id: grant.id, name: task.bot.name }],
  tasks: [{ ...task, groupGrantId: grant.id }],
  cursor: null,
  limit: 20,
  nextCursor: 'next-task-page',
  idempotencyKey: 'fresh-task-command',
};
const params = { workspaceId: workspace.id, conversationId: conversation.id };
const completed: TaskView = {
  ...task,
  status: 'completed',
  tokenBudgets: [
    {
      kind: 'run',
      used: { inputTokens: 12, outputTokens: 0, totalTokens: 12 },
      reserved: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      remaining: { totalTokens: 32756 },
    },
  ],
  runs: [
    {
      ...task.runs[0]!,
      status: 'completed',
      startedAt: '2026-09-05T00:00:01.000Z',
      finishedAt: '2026-09-05T00:00:02.000Z',
      provider: { protocol: 'openai-responses', modelId: 'actual-model' },
      usage: { inputTokens: 12, outputTokens: 0, estimated: false },
      output: {
        messageId: '50000000-0000-4000-8000-000000000005',
        eventId: '60000000-0000-4000-8000-000000000006',
        sequence: 2,
      },
    },
  ],
};
describe('Task pages', () => {
  it('renders the authorized cancellation command and explains its unfinished descendants', () => {
    const html = render(DetailPage, {
      props: {
        data: {
          ...base,
          task,
          canRetry: false,
          canCancel: true,
          canConfirmCancellation: true,
          canPause: true,
          canConfirmPause: true,
          idempotencyKey: 'stop-command',
        },
        params: { ...params, taskId: task.id },
        form: null,
      },
    }).body;
    expect(html).toContain('Cancel task');
    expect(html).toContain('Pause task');
    expect(html).toContain('unfinished work');
    expect(html).toContain('stop-command');
    expect(html).toContain(`name="expectedRunId" value="${task.runs[0]!.id}"`);
    expect(html).not.toContain('Retry failed task');
    expect(html).not.toContain('Resume paused task');
  });
  it('renders an escaped interrupted prefix and keeps only the original cancellation confirmation', () => {
    const stopped: TaskView = {
      ...task,
      status: 'cancelled',
      runs: [{ ...task.runs[0]!, status: 'cancelled', finishedAt: '2026-09-05T00:00:01.000Z' }],
    };
    const text = '<strong>Saved 🌲</strong>';
    const html = render(DetailPage, {
      props: {
        data: {
          ...base,
          task: stopped,
          canRetry: false,
          canConfirmCancellation: true,
          idempotencyKey: 'unused',
          partialOutput: {
            conversationId: conversation.id,
            taskId: task.id,
            runId: task.runs[0]!.id,
            partial: {
              text,
              endByte: new TextEncoder().encode(text).byteLength,
              interrupted: true,
            },
          },
        },
        params: { ...params, taskId: task.id },
        form: {
          cancellation: {
            values: { idempotencyKey: 'original-stop', expectedRunId: task.runs[0]!.id },
            uncertain: true,
            conflict: false,
            error: 'Confirm the saved command.',
          },
        },
      },
    }).body;
    expect(html).toContain('Cancelled');
    expect(html).toContain('Interrupted output');
    expect(html).toContain('&lt;strong>Saved 🌲&lt;/strong>');
    expect(html).not.toContain(text);
    expect(html).toContain('Confirm unchanged cancellation');
    expect(html).toContain('original-stop');
    expect(html).not.toContain('Confirm unchanged retry');
    expect(html).not.toContain('Confirm unchanged pause');
    expect(html).not.toContain('Edit message');
  });
  it('renders pause confirmation, resume, and interrupted output for a paused Task', () => {
    const paused: TaskView = {
      ...task,
      status: 'paused',
      runs: [{ ...task.runs[0]!, status: 'paused', finishedAt: '2026-09-05T00:00:01.000Z' }],
    };
    const text = 'Paused 🌲';
    const html = render(DetailPage, {
      props: {
        data: {
          ...base,
          task: paused,
          canRetry: false,
          canPause: false,
          canConfirmPause: true,
          canResume: true,
          canConfirmResume: true,
          idempotencyKey: 'resume-command',
          partialOutput: {
            conversationId: conversation.id,
            taskId: task.id,
            runId: task.runs[0]!.id,
            partial: {
              text,
              endByte: new TextEncoder().encode(text).byteLength,
              interrupted: true,
            },
          },
        },
        params: { ...params, taskId: task.id },
        form: {
          pause: {
            values: { idempotencyKey: 'original-pause', expectedRunId: task.runs[0]!.id },
            uncertain: true,
            conflict: false,
            error: 'Confirm the saved pause.',
          },
        },
      },
    }).body;
    expect(html).toContain('Paused');
    expect(html).toContain('Interrupted output');
    expect(html).toContain('restart from the original task input');
    expect(html).toContain('Paused 🌲');
    expect(html).toContain('Confirm unchanged pause');
    expect(html).toContain('original-pause');
    expect(html).toContain('Resume paused task');
    expect(html).toContain('resume-command');
    expect(html).not.toContain('Cancel task');
    expect(html).not.toContain('Retry failed task');
  });
  it('renders Interrupted for a worker-interrupted failed Run and keeps the saved prefix', () => {
    const interrupted: TaskView = {
      ...task,
      status: 'failed',
      runs: [
        {
          ...task.runs[0]!,
          status: 'failed',
          startedAt: '2026-09-05T00:00:01.000Z',
          finishedAt: '2026-09-05T00:00:02.000Z',
          provider: { protocol: 'openai-responses', modelId: 'actual-model' },
          error: 'worker_interrupted',
        },
      ],
    };
    const text = 'Interrupted 🌲';
    const html = render(DetailPage, {
      props: {
        data: {
          ...base,
          task: interrupted,
          canRetry: true,
          idempotencyKey: 'retry-after-interrupt',
          partialOutput: {
            conversationId: conversation.id,
            taskId: task.id,
            runId: task.runs[0]!.id,
            partial: {
              text,
              endByte: new TextEncoder().encode(text).byteLength,
              interrupted: true,
            },
          },
        },
        params: { ...params, taskId: task.id },
        form: null,
      },
    }).body;
    expect(html).toContain('Interrupted');
    expect(html).toContain('Interrupted output');
    expect(html).toContain('This task was interrupted.');
    expect(html).toContain('Interrupted 🌲');
    expect(html).toContain('Retry failed task');
  });
  it('renders saved earlier attempt evidence and bounded navigation alongside the current answer', () => {
    const current: TaskView = {
      ...completed,
      runCount: 2,
      olderRunsCursor: 'older_attempt',
      runs: [{ ...completed.runs[0]!, attempt: 2 }],
    };
    const failed = {
      ...completed.runs[0]!,
      id: task.bot.id,
      attempt: 1,
      status: 'failed' as const,
      output: null,
      error: 'provider_failed' as const,
    };
    const html = render(RunsPage, {
      props: {
        data: {
          ...base,
          task: current,
          canRetry: false,
          idempotencyKey: 'unused',
          runs: [failed],
          nextCursor: 'next_attempt_page',
          cursor: 'older_attempt',
          limit: 20,
        },
        params: { ...params, taskId: task.id },
        form: null,
      },
    }).body;
    for (const text of [
      'Attempt history',
      'Current attempt 2 of 2',
      'Attempt 1',
      'The model request failed.',
      'actual-model',
      'Input tokens: 12 · Output tokens: 0 · Actual',
      'Output tokens: 0',
      'next_attempt_page',
      'Older attempts',
      'Created',
      failed.createdAt,
      failed.finishedAt!,
    ])
      expect(html).toContain(text);
    expect(html).toContain(
      `?messageId=${completed.runs[0]!.output!.messageId}#message-${completed.runs[0]!.output!.messageId}`,
    );
    expect(html).not.toContain('<form');
  });
  it('shows an explicit retry and all earlier attempts while retaining the original Task prompt', () => {
    const failed: TaskView = {
      ...task,
      runCount: 2,
      olderRunsCursor: 'older_attempt',
      status: 'failed',
      runs: [
        {
          ...task.runs[0]!,
          attempt: 2,
          status: 'failed',
          finishedAt: '2026-09-05T00:00:01.000Z',
          error: 'execution_forbidden',
        },
      ],
    };
    const html = render(DetailPage, {
      props: {
        data: { ...base, task: failed, canRetry: true, idempotencyKey: 'new-retry-command' },
        params: { ...params, taskId: task.id },
        form: null,
      },
    }).body;
    expect(html).toContain('Current attempt 2 of 2');
    expect(html).toContain('View earlier attempts');
    expect(html).toContain('/runs?cursor=older_attempt');
    expect(html).toContain('Retry failed task');
    expect(html).toContain(`name="expectedRunId" value="${failed.runs[0]!.id}"`);
    expect(html).toContain('new-retry-command');
    expect(html).not.toContain('<textarea');
  });

  it('keeps the unchanged retry confirmation available after a refreshed Task has already completed', () => {
    const html = render(DetailPage, {
      props: {
        data: { ...base, task: completed, canRetry: false, idempotencyKey: 'unused-new-key' },
        params: { ...params, taskId: task.id },
        form: {
          values: { idempotencyKey: 'retained-key', expectedRunId: task.runs[0]!.id },
          uncertain: true,
          conflict: false,
          error: 'Check the original retry.',
        },
      },
    }).body;
    expect(html).toContain('Confirm unchanged retry');
    expect(html).toContain('retained-key');
    expect(html).not.toContain('unused-new-key');
    expect(html).toContain(`name="expectedRunId" value="${task.runs[0]!.id}"`);
  });
  it('shows a queued task, an explicit group Bot selector and durable page navigation', () => {
    const html = render(ListPage, { props: { data, form: null, params } }).body;
    for (const text of [
      'Queued',
      'Research Bot',
      'Configuration version 3',
      'Attempt 1',
      'Run task',
      'Automatic · default or local match',
      'fresh-task-command',
      'Refresh tasks',
      'next-task-page',
    ])
      expect(html).toContain(text);
    expect(html).toContain('method="POST"');
    expect(html).not.toContain('Send message');
  });
  it('shows actual model and usage on a completed saved attempt, including zero reported output tokens', () => {
    const html = render(DetailPage, {
      props: {
        data: { ...base, task: completed, canRetry: false, idempotencyKey: 'unused-key' },
        params: { ...params, taskId: task.id },
        form: null,
      },
    }).body;
    for (const text of [
      'Completed',
      'actual-model',
      'openai-responses',
      'Input tokens: 12 · Output tokens: 0 · Actual',
      'Output tokens: 0',
      'Token budget',
      'This run: used 12 · reserved 0 · remaining total 32756',
      'Refresh task',
      completed.runs[0]!.output!.messageId,
    ])
      expect(html).toContain(text);
    expect(html).toContain(
      `?messageId=${completed.runs[0]!.output!.messageId}#message-${completed.runs[0]!.output!.messageId}`,
    );
    expect(html).not.toContain('Run task');
  });
  it('shows a planned fallback previous model, next model and reason before the next call', () => {
    const waiting: TaskView = {
      ...task,
      runCount: 2,
      olderRunsCursor: 'older_attempt',
      runs: [
        {
          ...task.runs[0]!,
          attempt: 2,
          continuation: {
            origin: 'model_fallback',
            reason: 'provider_unavailable',
            previousRunId: task.runs[0]!.id,
            previousProvider: { protocol: 'openai-chat', modelId: 'primary-model' },
            nextProvider: { protocol: 'openai-chat', modelId: 'fallback-model' },
            dueAt: '2026-09-05T00:00:01.000Z',
            admitted: false,
          },
        },
      ],
    };
    const html = render(DetailPage, {
      props: {
        data: { ...base, task: waiting, canRetry: false, idempotencyKey: 'unused-key' },
        params: { ...params, taskId: task.id },
        form: null,
      },
    }).body;
    expect(html).toContain('Waiting to switch models');
    expect(html).toContain('primary-model · openai-chat');
    expect(html).toContain('fallback-model · openai-chat');
    expect(html).toContain('the previous model was temporarily unavailable');
    expect(html).toContain('A model has not been called.');
    expect(html).toContain('Planned model: fallback-model · openai-chat');
    expect(html).not.toContain('connectionId');
    expect(html).not.toContain('baseUrl');
  });
  it('preserves the complete uncertain request and permits only unchanged replay', () => {
    const html = render(ListPage, {
      props: {
        data,
        params,
        form: {
          values: {
            idempotencyKey: 'uncertain-key',
            body: 'My exact\n  prompt',
            groupGrantId: grant.id,
          },
          error: 'Check the original submission.',
          uncertain: true,
          conflict: false,
        },
      },
    }).body;
    expect(html).toContain('uncertain-key');
    expect(html).toContain('My exact\n  prompt');
    expect(html).toContain('Retry unchanged request');
    expect(html).toMatch(/<textarea[^>]*readonly/u);
    expect(html).toMatch(/<select[^>]*disabled/u);
    expect(html).toContain(`type="hidden" name="groupGrantId" value="${grant.id}"`);
  });
});
