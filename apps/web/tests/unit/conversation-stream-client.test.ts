import { describe, expect, it } from 'vitest';
import { consumeConversationStream } from '../../src/lib/conversation-stream-client.js';
import {
  encodeConversationStreamCursor,
  type ExecutionState,
} from '../../src/lib/conversation-stream-contract.js';
import { message, conversation, workspace, user } from '../fixtures/conversations.js';

const scope = { workspaceId: workspace.id, conversationId: conversation.id };
const taskId = '20000000-0000-4000-8000-000000000002',
  runId = '30000000-0000-4000-8000-000000000003';
const cursor = (sequence: number) => encodeConversationStreamCursor(scope, sequence);
const bootstrap = {
  schemaVersion: 1,
  cursor: cursor(0),
  conversationId: scope.conversationId,
  messages: [],
  nextMessageCursor: null,
  executions: [],
  nextTaskCursor: null,
  previews: [],
  previewsTruncated: false,
};
function frame(sequence: number, type: string, data: unknown) {
  return `id: ${cursor(sequence)}\nevent: ${type}\ndata: ${JSON.stringify({ schemaVersion: 1, cursor: cursor(sequence), conversationId: scope.conversationId, sequence, occurredAt: conversation.createdAt, type, data })}\n\n`;
}
function streaming(chunks: string[], fail = false) {
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk !== undefined) controller.enqueue(new TextEncoder().encode(chunk));
          else if (fail) controller.error(new Error('network interrupted'));
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}
function execution(index: number, status: 'running' | 'cancelled'): ExecutionState {
  return {
    taskId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    runId: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    attempt: 1,
    taskStatus: status,
    runStatus: status,
    bot: { id: user.id, displayName: 'Bot', versionId: runId, versionNumber: 1 },
    executionUser: { id: user.id, displayName: user.displayName },
    createdAt: conversation.createdAt,
    startedAt: conversation.createdAt,
    finishedAt: status === 'cancelled' ? conversation.createdAt : null,
    provider: { protocol: 'openai-chat', modelId: 'model' },
    usage: null,
    error: null,
    output: null,
  };
}

describe('conversation browser streaming lifecycle', () => {
  it.each(['bootstrap', 'event'] as const)(
    'keeps SSE and another Run progressing after a cancelled %s partial returns 503',
    async (source) => {
      const abort = new AbortController(),
        cancelled = execution(1, 'cancelled'),
        other = execution(2, 'running'),
        requests: string[] = [],
        seen: ExecutionState[] = [];
      const timer = setTimeout(() => abort.abort(), 500);
      try {
        await consumeConversationStream({
          scope,
          signal: abort.signal,
          retryMs: 0,
          request: async (input, init) => {
            const url = String(input);
            requests.push(url);
            expect(init?.method).toBe('GET');
            if (url.endsWith('/bootstrap'))
              return Response.json({
                ...bootstrap,
                executions: source === 'bootstrap' ? [cancelled] : [execution(1, 'running')],
              });
            if (url.endsWith('/partial-output')) return new Response(null, { status: 503 });
            expect(new Headers(init?.headers).get('last-event-id')).toBe(cursor(0));
            return streaming([
              ...(source === 'event'
                ? [frame(1, 'task.run.updated', { execution: cancelled })]
                : []),
              frame(source === 'event' ? 2 : 1, 'task.run.updated', { execution: other }),
            ]);
          },
          onStatus: () => undefined,
          onReset: () => undefined,
          onMessage: () => {
            throw new Error('partial degradation invented a message');
          },
          onClearMessage: () => undefined,
          onState: (state) => {
            if (state?.executions[other.runId]) {
              seen.push(state.executions[other.runId]!);
              abort.abort();
            }
          },
        });
      } finally {
        clearTimeout(timer);
      }
      expect(seen).toEqual([other]);
      expect(requests.filter((url) => url.endsWith('/events'))).toHaveLength(1);
      expect(requests.filter((url) => url.endsWith('/partial-output'))).toHaveLength(1);
    },
  );
  it('consumes live updates while a cancelled partial request is pending and aborts that independent request on stop', async () => {
    const abort = new AbortController(),
      other = execution(2, 'running');
    let applied = false,
      partialAborted = false;
    const timer = setTimeout(() => abort.abort(), 500);
    try {
      await consumeConversationStream({
        scope,
        signal: abort.signal,
        request: async (input, init) => {
          const url = String(input);
          if (url.endsWith('/bootstrap'))
            return Response.json({ ...bootstrap, executions: [execution(1, 'cancelled')] });
          if (url.endsWith('/partial-output'))
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => {
                  partialAborted = true;
                  reject(new DOMException('Aborted', 'AbortError'));
                },
                { once: true },
              );
            });
          return streaming([frame(1, 'task.run.updated', { execution: other })]);
        },
        onStatus: () => undefined,
        onReset: () => undefined,
        onMessage: () => undefined,
        onClearMessage: () => undefined,
        onState: (state) => {
          if (state?.executions[other.runId]) {
            applied = true;
            abort.abort();
          }
        },
      });
    } finally {
      clearTimeout(timer);
    }
    expect(applied).toBe(true);
    expect(partialAborted).toBe(true);
  });
  it('resumes the applied cursor after partial degradation and restores a later cancelled Run without retrying the failed detail', async () => {
    const abort = new AbortController(),
      first = execution(1, 'cancelled'),
      later = execution(2, 'cancelled'),
      requests: string[] = [],
      cursors: (string | null)[] = [];
    let restored = false;
    const timer = setTimeout(() => abort.abort(), 500);
    try {
      await consumeConversationStream({
        scope,
        signal: abort.signal,
        retryMs: 0,
        request: async (input, init) => {
          const url = String(input);
          requests.push(url);
          if (url.endsWith('/bootstrap'))
            return Response.json({ ...bootstrap, executions: [first] });
          if (url.endsWith(`/runs/${first.runId}/partial-output`))
            return new Response(null, { status: 503 });
          if (url.endsWith('/partial-output'))
            return Response.json({
              conversationId: scope.conversationId,
              taskId: later.taskId,
              runId: later.runId,
              partial: { text: 'Saved 🌱', endByte: 10, interrupted: true },
            });
          cursors.push(new Headers(init?.headers).get('last-event-id'));
          return cursors.length === 1
            ? streaming(
                [frame(1, 'task.run.updated', { execution: execution(2, 'running') })],
                true,
              )
            : streaming([
                frame(2, 'task.run.updated', { execution: later }),
                frame(3, 'conversation.invalidated', { reason: 'membership' }),
              ]);
        },
        onStatus: () => undefined,
        onReset: () => undefined,
        onMessage: () => {
          throw new Error('partial recovery invented a final message');
        },
        onClearMessage: () => undefined,
        onState: (state) => {
          if (
            state?.acknowledgedSequence === 3 &&
            state.previews[later.runId]?.status === 'interrupted'
          ) {
            restored = state.previews[later.runId]?.text === 'Saved 🌱';
            abort.abort();
          }
        },
      });
    } finally {
      clearTimeout(timer);
    }
    expect(restored).toBe(true);
    expect(cursors).toEqual([cursor(0), cursor(1)]);
    expect(requests.filter((url) => url.endsWith('/bootstrap'))).toHaveLength(1);
    expect(
      requests.filter((url) => url.endsWith(`/runs/${first.runId}/partial-output`)),
    ).toHaveLength(1);
    expect(
      requests.filter((url) => url.endsWith(`/runs/${later.runId}/partial-output`)),
    ).toHaveLength(1);
  });
  it.each([401, 403])(
    'stops a healthy stream and clears private state when a partial reader returns %i',
    async (status) => {
      const abort = new AbortController(),
        statuses: string[] = [];
      let cleared = false;
      const timer = setTimeout(() => abort.abort(), 500);
      try {
        await consumeConversationStream({
          scope,
          signal: abort.signal,
          request: async (input) => {
            const url = String(input);
            if (url.endsWith('/bootstrap'))
              return Response.json({ ...bootstrap, executions: [execution(1, 'cancelled')] });
            if (url.endsWith('/partial-output')) return new Response(null, { status });
            return streaming([]);
          },
          onStatus: (value) => statuses.push(value),
          onReset: () => undefined,
          onMessage: () => {
            throw new Error('forbidden private output applied');
          },
          onClearMessage: () => undefined,
          onState: (state) => {
            if (state === null) cleared = true;
          },
        });
      } finally {
        clearTimeout(timer);
      }
      expect(cleared).toBe(true);
      expect(statuses.at(-1)).toBe(status === 401 ? 'authentication-required' : 'forbidden');
    },
  );
  it('restores cancelled partial output once after a fresh bootstrap without reconnecting or submitting', async () => {
    const abort = new AbortController(),
      requests: string[] = [],
      seen: string[] = [],
      messages: string[] = [];
    const cancelled = {
      taskId,
      runId,
      attempt: 1,
      taskStatus: 'cancelled',
      runStatus: 'cancelled',
      bot: { id: user.id, displayName: 'Bot', versionId: runId, versionNumber: 1 },
      executionUser: { id: user.id, displayName: user.displayName },
      createdAt: conversation.createdAt,
      startedAt: conversation.createdAt,
      finishedAt: conversation.createdAt,
      provider: { protocol: 'openai-chat', modelId: 'model' },
      usage: null,
      error: null,
      output: null,
    };
    await consumeConversationStream({
      scope,
      signal: abort.signal,
      retryMs: 0,
      request: async (input, init) => {
        const url = String(input);
        requests.push(url);
        expect(init?.method).toBe('GET');
        if (url.endsWith('/bootstrap'))
          return Response.json({ ...bootstrap, executions: [cancelled] });
        if (url.endsWith('/partial-output'))
          return Response.json({
            conversationId: scope.conversationId,
            taskId,
            runId,
            partial: { text: 'Saved 🌱', endByte: 10, interrupted: true },
          });
        return streaming([]);
      },
      onStatus: () => undefined,
      onReset: () => undefined,
      onClearMessage: () => undefined,
      onMessage: (m) => messages.push(m.id),
      onState: (state) => {
        const preview = state?.previews[runId];
        if (preview?.status === 'interrupted') {
          seen.push(preview.text);
          abort.abort();
        }
      },
    });
    expect(seen).toEqual(['Saved 🌱']);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatch(/\/events$/u);
    expect(requests[1]).toContain(`/tasks/${taskId}/runs/${runId}/partial-output`);
    expect(messages).toEqual([]);
  });
  it('accepts a current purge marker at the same immutable message revision without a rebootstrap loop', async () => {
    const abort = new AbortController(),
      applied: boolean[] = [];
    let bootstraps = 0;
    const reference = {
      messageId: message.id,
      creationSequence: 1,
      versionEventId: message.versionEventId,
      sequence: 1,
      deleted: false,
      taskId: null,
      runId: null,
    };
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/bootstrap')) {
        bootstraps++;
        return Response.json(bootstrap);
      }
      if (url.includes('/messages/'))
        return Response.json({
          message: {
            ...message,
            creationSequence: 1,
            sequence: 1,
            deleted: true,
            body: null,
            reason: 'Permanently purged',
            canEdit: false,
            canDelete: false,
            canAudit: false,
          },
        });
      return streaming([frame(1, 'message.changed', { message: reference })]);
    };
    await consumeConversationStream({
      scope,
      request: fetcher,
      signal: abort.signal,
      retryMs: 0,
      onStatus: () => undefined,
      onReset: () => undefined,
      onClearMessage: () => undefined,
      onMessage: (value) => applied.push(value.deleted),
      onState: (state) => {
        if (state?.acknowledgedSequence === 1) abort.abort();
      },
    });
    expect(applied).toEqual([true]);
    expect(bootstraps).toBe(1);
  });

  it('rebootstraps an expired cursor, acknowledges an omitted active prefix and converges without resubmitting', async () => {
    const abort = new AbortController(),
      requests: { url: string; cursor: string | null }[] = [],
      seen: string[] = [];
    let bootstraps = 0;
    let unavailable = false;
    const final = {
      ...message,
      creationSequence: 22,
      sequence: 22,
      body: 'complete answer',
      author: { kind: 'bot', id: user.id, displayName: 'Bot', versionId: runId, versionNumber: 1 },
      canEdit: false,
      canDelete: false,
      canAudit: false,
    };
    const reference = {
      messageId: final.id,
      creationSequence: 22,
      sequence: 22,
      versionEventId: final.versionEventId,
      deleted: false,
      taskId,
      runId,
    };
    const previews = Array.from({ length: 8 }, (_, index) => ({
      taskId: `20000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
      runId: `30000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
      attempt: 1,
      endByte: 1,
      text: 'x',
    }));
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input),
        after = new Headers(init?.headers).get('last-event-id');
      requests.push({ url, cursor: after });
      expect(init?.method).toBe('GET');
      if (url.endsWith('/bootstrap'))
        return Response.json(
          ++bootstraps === 1
            ? bootstrap
            : { ...bootstrap, cursor: cursor(20), previews, previewsTruncated: true },
        );
      if (url.includes('/messages/')) return Response.json({ message: final });
      if (after === cursor(0))
        return Response.json({ error: { code: 'cursor_expired' } }, { status: 410 });
      return streaming([
        frame(21, 'assistant.delta', {
          taskId,
          runId,
          attempt: 1,
          startByte: 5,
          endByte: 10,
          text: 'later',
        }),
        frame(22, 'message.changed', { message: reference }),
      ]);
    };
    await consumeConversationStream({
      scope,
      request: fetcher,
      signal: abort.signal,
      retryMs: 0,
      onStatus: () => undefined,
      onReset: () => undefined,
      onClearMessage: () => undefined,
      onMessage: (value) => seen.push(value.id),
      onState: (state) => {
        if (state?.acknowledgedSequence === 21 && !state.pendingMessage) {
          unavailable =
            state.previews[runId]?.status === 'unavailable' && state.previews[runId]?.text === '';
        }
        if (state?.acknowledgedSequence === 22) {
          expect(state.previews[runId]).toBeUndefined();
          abort.abort();
        }
      },
    });
    expect(unavailable).toBe(true);
    expect(bootstraps).toBe(2);
    expect(seen).toEqual([final.id]);
    expect(
      requests
        .filter((request) => request.url.endsWith('/events'))
        .map((request) => request.cursor),
    ).toEqual([cursor(0), cursor(20)]);
  });

  it('reconnects after only the applied event and resolves exactly one current final message', async () => {
    const abort = new AbortController(),
      seen: string[] = [],
      requests: { url: string; cursor: string | null }[] = [];
    const first = frame(1, 'assistant.delta', {
      taskId,
      runId,
      attempt: 1,
      startByte: 0,
      endByte: 1,
      text: 'a',
    });
    const second = frame(2, 'assistant.delta', {
      taskId,
      runId,
      attempt: 1,
      startByte: 1,
      endByte: 2,
      text: 'b',
    });
    const final = {
      ...message,
      creationSequence: 3,
      sequence: 3,
      body: 'ab',
      author: { kind: 'bot', id: user.id, displayName: 'Bot', versionId: runId, versionNumber: 1 },
      canEdit: false,
      canDelete: false,
      canAudit: false,
    };
    const reference = {
      messageId: final.id,
      creationSequence: 3,
      versionEventId: final.versionEventId,
      sequence: 3,
      deleted: false,
      taskId,
      runId,
    };
    let streams = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, cursor: new Headers(init?.headers).get('last-event-id') });
      expect(init?.method ?? 'GET').toBe('GET');
      if (url.endsWith('/bootstrap')) return Response.json(bootstrap);
      if (url.endsWith('/messages/' + final.id)) return Response.json({ message: final });
      return ++streams === 1
        ? streaming([first, second.slice(0, 30)], true)
        : streaming([second, frame(3, 'message.changed', { message: reference })]);
    };
    await consumeConversationStream({
      scope,
      request: fetcher,
      signal: abort.signal,
      retryMs: 0,
      onStatus: () => undefined,
      onReset: () => undefined,
      onClearMessage: () => undefined,
      onMessage: (value) => {
        seen.push(value.id);
      },
      onState: (state) => {
        if (state?.acknowledgedSequence === 3) abort.abort();
      },
    });
    expect(
      requests
        .filter((request) => request.url.endsWith('/events'))
        .map((request) => request.cursor),
    ).toEqual([cursor(0), cursor(1)]);
    expect(seen).toEqual([final.id]);
  });

  it('terminates on a forbidden targeted locator instead of endlessly replaying the old event', async () => {
    const statuses: string[] = [],
      requests: string[] = [];
    const reference = {
      messageId: message.id,
      creationSequence: 1,
      versionEventId: message.versionEventId,
      sequence: 20,
      deleted: false,
      taskId: null,
      runId: null,
    };
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/bootstrap')) return Response.json(bootstrap);
      if (url.includes('/messages/'))
        return Response.json({ error: { code: 'conversation_forbidden' } }, { status: 403 });
      return streaming([frame(1, 'message.changed', { message: reference })]);
    };
    await consumeConversationStream({
      scope,
      request: fetcher,
      signal: new AbortController().signal,
      retryMs: 0,
      onStatus: (status) => statuses.push(status),
      onReset: () => undefined,
      onClearMessage: () => undefined,
      onMessage: () => {
        throw new Error('forbidden body applied');
      },
      onState: () => undefined,
    });
    expect(statuses.at(-1)).toBe('forbidden');
    expect(requests).toHaveLength(3);
  });
});
