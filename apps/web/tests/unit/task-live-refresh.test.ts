import { describe, expect, it } from 'vitest';
import {
  encodeConversationStreamCursor,
  parseConversationStreamEvent,
  type ConversationStreamEvent,
} from '../../src/lib/conversation-stream-contract.js';
import { shouldRefreshTaskUi } from '../../src/lib/task-live-refresh.js';

const scope = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  conversationId: '10000000-0000-4000-8000-000000000002',
};
const taskId = '20000000-0000-4000-8000-000000000010';
const otherTaskId = '20000000-0000-4000-8000-000000000011';
const runId = '30000000-0000-4000-8000-000000000020';
const instant = '2030-01-01T00:00:00.000Z';

function event(sequence: number, type: string, data: unknown): ConversationStreamEvent {
  const parsed = parseConversationStreamEvent(
    {
      schemaVersion: 1,
      cursor: encodeConversationStreamCursor(scope, sequence),
      conversationId: scope.conversationId,
      sequence,
      occurredAt: instant,
      type,
      data,
    },
    scope,
  );
  if (!parsed) throw new Error(`invalid fixture ${type}`);
  return parsed;
}

const execution = (id: string, status: 'queued' | 'running' | 'failed' = 'queued') => ({
  taskId: id,
  runId,
  attempt: status === 'queued' ? 2 : 1,
  taskStatus: status,
  runStatus: status,
  bot: {
    id: '40000000-0000-4000-8000-000000000040',
    displayName: 'Bot',
    versionId: '40000000-0000-4000-8000-000000000041',
    versionNumber: 1,
  },
  executionUser: {
    id: '40000000-0000-4000-8000-000000000042',
    displayName: 'Owner',
  },
  createdAt: instant,
  startedAt: status === 'queued' ? null : instant,
  finishedAt: status === 'failed' ? instant : null,
  provider: status === 'queued' ? null : { protocol: 'openai-chat' as const, modelId: 'm' },
  usage: null,
  error: status === 'failed' ? ('provider_failed' as const) : null,
  output: null,
});

describe('task live refresh selection', () => {
  it('refreshes on approval decisions and retries for the open task', () => {
    expect(
      shouldRefreshTaskUi(
        event(1, 'task.human.decided', {
          taskId,
          kind: 'approval',
          decision: 'approve',
        }),
        taskId,
      ),
    ).toBe(true);
    expect(
      shouldRefreshTaskUi(
        event(2, 'task.run.updated', { execution: execution(taskId, 'queued') }),
        taskId,
      ),
    ).toBe(true);
    expect(
      shouldRefreshTaskUi(
        event(3, 'task.approval.requested', { taskId, summary: 'Deploy' }),
        taskId,
      ),
    ).toBe(true);
    expect(
      shouldRefreshTaskUi(
        event(4, 'task.input.requested', {
          taskId,
          prompt: 'Name?',
          responseSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        }),
        taskId,
      ),
    ).toBe(true);
  });

  it('ignores unrelated tasks and non-task UI events', () => {
    expect(
      shouldRefreshTaskUi(
        event(1, 'task.human.decided', {
          taskId: otherTaskId,
          kind: 'approval',
          decision: 'reject',
        }),
        taskId,
      ),
    ).toBe(false);
    expect(
      shouldRefreshTaskUi(
        event(2, 'task.run.updated', { execution: execution(otherTaskId, 'failed') }),
        taskId,
      ),
    ).toBe(false);
    expect(
      shouldRefreshTaskUi(event(3, 'conversation.invalidated', { reason: 'membership' }), taskId),
    ).toBe(false);
  });

  it('refreshes any conversation task event when no task filter is set', () => {
    expect(
      shouldRefreshTaskUi(
        event(1, 'task.human.decided', {
          taskId: otherTaskId,
          kind: 'input',
          decision: 'input',
        }),
      ),
    ).toBe(true);
    expect(
      shouldRefreshTaskUi(
        event(2, 'task.run.updated', { execution: execution(otherTaskId, 'queued') }),
      ),
    ).toBe(true);
  });
});

import { watchTaskLiveRefresh } from '../../src/lib/task-live-refresh-client.js';
import { consumeConversationStream } from '../../src/lib/conversation-stream-client.js';

describe('task live refresh stream watch', () => {
  it('coalesces human decisions and retries into one refresh without a full navigation', async () => {
    const abort = new AbortController();
    const refreshed: string[] = [];
    const statuses: string[] = [];
    const bootstrapBody = {
      schemaVersion: 1,
      cursor: encodeConversationStreamCursor(scope, 0),
      conversationId: scope.conversationId,
      messages: [],
      nextMessageCursor: null,
      executions: [],
      nextTaskCursor: null,
      previews: [],
      previewsTruncated: false,
    };
    const decided = `id: ${encodeConversationStreamCursor(scope, 1)}\nevent: task.human.decided\ndata: ${JSON.stringify(
      {
        schemaVersion: 1,
        cursor: encodeConversationStreamCursor(scope, 1),
        conversationId: scope.conversationId,
        sequence: 1,
        occurredAt: instant,
        type: 'task.human.decided',
        data: { taskId, kind: 'approval', decision: 'approve' },
      },
    )}\n\n`;
    const retried = `id: ${encodeConversationStreamCursor(scope, 2)}\nevent: task.run.updated\ndata: ${JSON.stringify(
      {
        schemaVersion: 1,
        cursor: encodeConversationStreamCursor(scope, 2),
        conversationId: scope.conversationId,
        sequence: 2,
        occurredAt: instant,
        type: 'task.run.updated',
        data: { execution: execution(taskId, 'queued') },
      },
    )}\n\n`;
    const chunks = [decided + retried];
    const timer = setTimeout(() => abort.abort(), 400);
    try {
      await watchTaskLiveRefresh({
        scope,
        taskId,
        signal: abort.signal,
        retryMs: 0,
        coalesceMs: 30,
        onStatus(status) {
          statuses.push(status);
        },
        refresh() {
          refreshed.push('task-ui');
        },
        request: async (input) => {
          const url = String(input);
          if (url.endsWith('/bootstrap'))
            return new Response(JSON.stringify(bootstrapBody), {
              headers: { 'content-type': 'application/json' },
            });
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                const chunk = chunks.shift();
                if (chunk !== undefined) controller.enqueue(new TextEncoder().encode(chunk));
                else controller.error(new Error('end'));
              },
            }),
            { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
          );
        },
      });
    } finally {
      clearTimeout(timer);
    }
    expect(statuses).toContain('live');
    expect(refreshed).toEqual(['task-ui']);
  });

  it('forwards applied stream events through onEvent for task UI consumers', async () => {
    const abort = new AbortController();
    const seen: string[] = [];
    const bootstrapBody = {
      schemaVersion: 1,
      cursor: encodeConversationStreamCursor(scope, 0),
      conversationId: scope.conversationId,
      messages: [],
      nextMessageCursor: null,
      executions: [],
      nextTaskCursor: null,
      previews: [],
      previewsTruncated: false,
    };
    const frame = `id: ${encodeConversationStreamCursor(scope, 1)}\nevent: task.human.decided\ndata: ${JSON.stringify(
      {
        schemaVersion: 1,
        cursor: encodeConversationStreamCursor(scope, 1),
        conversationId: scope.conversationId,
        sequence: 1,
        occurredAt: instant,
        type: 'task.human.decided',
        data: { taskId, kind: 'approval', decision: 'reject' },
      },
    )}\n\n`;
    const chunks = [frame];
    const timer = setTimeout(() => abort.abort(), 300);
    try {
      await consumeConversationStream({
        scope,
        signal: abort.signal,
        retryMs: 0,
        request: async (input) => {
          const url = String(input);
          if (url.endsWith('/bootstrap'))
            return new Response(JSON.stringify(bootstrapBody), {
              headers: { 'content-type': 'application/json' },
            });
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                const chunk = chunks.shift();
                if (chunk !== undefined) controller.enqueue(new TextEncoder().encode(chunk));
                else controller.error(new Error('end'));
              },
            }),
            { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
          );
        },
        onStatus() {},
        onReset() {},
        onState() {},
        onMessage() {},
        onClearMessage() {},
        onEvent(event) {
          seen.push(event.type);
        },
      });
    } finally {
      clearTimeout(timer);
    }
    expect(seen).toEqual(['task.human.decided']);
  });
});
