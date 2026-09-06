import { describe, expect, it } from 'vitest';
import {
  createConversationStreamState,
  applyConversationStreamEvent,
  resolveConversationStreamMessage,
  resolveCancelledTaskPartial,
} from '../../src/lib/conversation-stream-state.js';
import {
  encodeConversationStreamCursor,
  parseConversationStreamBootstrap,
  parseConversationStreamEvent,
  type ConversationStreamBootstrap,
  type ExecutionState,
  type MessageReference,
} from '../../src/lib/conversation-stream-contract.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const scope = { workspaceId: id(1), conversationId: id(2) };
const cursor = (after: number) => encodeConversationStreamCursor(scope, after);
const instant = '2030-01-01T00:00:00.000Z';
const execution = (n = 0): ExecutionState => ({
  taskId: id(100 + n),
  runId: id(200 + n),
  attempt: 1,
  taskStatus: 'running',
  runStatus: 'running',
  bot: { id: id(3), displayName: 'Assistant', versionId: id(4), versionNumber: 1 },
  executionUser: { id: id(5), displayName: 'Viewer' },
  createdAt: instant,
  startedAt: instant,
  finishedAt: null,
  provider: { protocol: 'openai-chat', modelId: 'model-1' },
  usage: null,
  error: null,
  output: null,
});
function bootstrap(changes: Partial<ConversationStreamBootstrap> = {}) {
  const parsed = parseConversationStreamBootstrap(
    JSON.stringify({
      schemaVersion: 1,
      cursor: cursor(0),
      conversationId: scope.conversationId,
      messages: [],
      executions: [],
      previews: [],
      previewsTruncated: false,
      nextMessageCursor: null,
      nextTaskCursor: null,
      ...changes,
    }),
    scope,
  );
  if (!parsed) throw new Error('Invalid bootstrap fixture');
  return parsed;
}
function event(sequence: number, type: string, data: unknown) {
  const parsed = parseConversationStreamEvent(
    {
      schemaVersion: 1,
      cursor: cursor(sequence),
      conversationId: scope.conversationId,
      sequence,
      occurredAt: instant,
      type,
      data,
    },
    scope,
  );
  if (!parsed) throw new Error('Invalid event fixture');
  return parsed;
}
const delta = (sequence: number, startByte: number, endByte: number, text: string, n = 0) =>
  event(sequence, 'assistant.delta', {
    taskId: id(100 + n),
    runId: id(200 + n),
    attempt: 1,
    startByte,
    endByte,
    text,
  });
const reference = (sequence: number, n = 0): MessageReference => ({
  messageId: id(500 + n),
  creationSequence: sequence,
  versionEventId: id(600 + sequence),
  sequence,
  deleted: false,
  taskId: id(100 + n),
  runId: id(200 + n),
});
const revision = (message: MessageReference) => ({
  id: message.messageId,
  creationSequence: message.creationSequence,
  versionEventId: message.versionEventId,
  sequence: message.sequence,
  deleted: message.deleted,
});

describe('conversation stream convergence', () => {
  it('marks the streamed prefix interrupted on cancellation and ignores a late delta', () => {
    const initial = createConversationStreamState(bootstrap({ executions: [execution()] }));
    const streamed = applyConversationStreamEvent(initial, delta(1, 0, 7, 'hi 🌍'));
    const stopped = applyConversationStreamEvent(
      streamed.state,
      event(2, 'task.run.updated', {
        execution: {
          ...execution(),
          taskStatus: 'cancelled',
          runStatus: 'cancelled',
          finishedAt: instant,
        },
      }),
    );
    expect(stopped.status).toBe('applied');
    expect(stopped.state.previews[id(200)]).toMatchObject({
      status: 'interrupted',
      text: 'hi 🌍',
      endByte: 7,
    });
    const late = applyConversationStreamEvent(stopped.state, delta(3, 7, 11, 'LATE'));
    expect(late.status).toBe('applied');
    expect(late.state.previews).toEqual(stopped.state.previews);
    expect(late.state.messages).toEqual({});
  });

  it('acknowledges a limit warning without mutating executions or previews', () => {
    const initial = createConversationStreamState(bootstrap({ executions: [execution()] }));
    const warned = applyConversationStreamEvent(
      initial,
      event(1, 'task.limit.warning', {
        taskId: id(100),
        dimension: 'turns',
        used: 1,
        limit: 1,
        source: 'workspace',
        soft: true,
        hard: true,
        body: 'Turn usage reached the 1 turns workspace limit.',
      }),
    );
    expect(warned.status).toBe('applied');
    expect(warned.state.acknowledgedCursor).toBe(cursor(1));
    expect(warned.state.executions).toEqual(initial.executions);
    expect(warned.state.previews).toEqual(initial.previews);
  });
  it('restores the complete private cancelled prefix after bootstrap without inventing a final message', () => {
    const cancelled = {
      ...execution(),
      taskStatus: 'cancelled' as const,
      runStatus: 'cancelled' as const,
      finishedAt: instant,
    };
    const initial = createConversationStreamState(bootstrap({ executions: [cancelled] }));
    const result = resolveCancelledTaskPartial(initial, {
      conversationId: scope.conversationId,
      taskId: cancelled.taskId,
      runId: cancelled.runId,
      partial: { text: 'hi 🌍', endByte: 7, interrupted: true },
    });
    expect(result.previews[cancelled.runId]).toMatchObject({
      text: 'hi 🌍',
      status: 'interrupted',
    });
    expect(result.acknowledgedCursor).toBe(initial.acknowledgedCursor);
    expect(result.messages).toEqual({});
  });
  it.each(['cancelled', 'running'] as const)(
    'retains interrupted Bot identity while bounding later %s execution history',
    (laterStatus) => {
      const cancelled = {
        ...execution(),
        taskStatus: 'cancelled' as const,
        runStatus: 'cancelled' as const,
        finishedAt: instant,
      };
      let state = resolveCancelledTaskPartial(
        createConversationStreamState(bootstrap({ executions: [cancelled] })),
        {
          conversationId: scope.conversationId,
          taskId: cancelled.taskId,
          runId: cancelled.runId,
          partial: { text: 'hi 🌍', endByte: 7, interrupted: true },
        },
      );
      for (let n = 1; n <= 70; n++) {
        const result = applyConversationStreamEvent(
          state,
          event(n, 'task.run.updated', {
            execution: {
              ...execution(n),
              taskStatus: laterStatus,
              runStatus: laterStatus,
              finishedAt: laterStatus === 'cancelled' ? instant : null,
            },
          }),
        );
        expect(result.status).toBe('applied');
        state = result.state;
      }
      expect(Object.keys(state.executions)).toHaveLength(64);
      expect(state.previews[cancelled.runId]).toMatchObject({
        text: 'hi 🌍',
        status: 'interrupted',
      });
      expect(state.executions[cancelled.runId]).toEqual(cancelled);
      const late = applyConversationStreamEvent(state, delta(71, 7, 11, 'LATE'));
      expect(late.state.previews).toEqual(state.previews);
    },
  );
  it('retains persisted attempt numbers and rejects changing attempt identity within a run', () => {
    const run = { ...execution(), attempt: 2 };
    const initial = createConversationStreamState(bootstrap({ executions: [run] }));
    const first = applyConversationStreamEvent(
      initial,
      event(1, 'assistant.delta', {
        taskId: run.taskId,
        runId: run.runId,
        attempt: 2,
        startByte: 0,
        endByte: 1,
        text: 'x',
      }),
    );
    expect(first.state.previews[run.runId]?.attempt).toBe(2);
    const changed = event(2, 'assistant.delta', {
      taskId: run.taskId,
      runId: run.runId,
      attempt: 1,
      startByte: 1,
      endByte: 2,
      text: 'y',
    });
    expect(applyConversationStreamEvent(first.state, changed).status).toBe('resync-required');
    expect(
      applyConversationStreamEvent(
        first.state,
        event(2, 'task.run.updated', {
          execution: { ...run, attempt: 1 },
        }),
      ).status,
    ).toBe('resync-required');
  });

  it('applies Unicode delta offsets once without mutating the prior state', () => {
    const initial = createConversationStreamState(bootstrap());
    const first = applyConversationStreamEvent(initial, delta(1, 0, 7, 'hi 🌍'));
    expect(first.status).toBe('applied');
    expect(first.state.acknowledgedCursor).toBe(cursor(1));
    expect(first.state.previews[id(200)]).toMatchObject({
      status: 'streaming',
      text: 'hi 🌍',
      endByte: 7,
    });
    expect(initial.previews).toEqual({});
    const duplicate = applyConversationStreamEvent(first.state, delta(1, 0, 7, 'hi 🌍'));
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.state).toBe(first.state);
    const second = applyConversationStreamEvent(first.state, delta(2, 7, 8, '!'));
    expect(second.state.previews[id(200)]?.text).toBe('hi 🌍!');
    const offsetReplay = applyConversationStreamEvent(second.state, delta(3, 0, 7, 'hi 🌍'));
    expect(offsetReplay.status).toBe('applied');
    expect(offsetReplay.state.previews[id(200)]?.text).toBe('hi 🌍!');
  });

  it('holds acknowledgement until a current message locator result resolves the exact reference', () => {
    const state = applyConversationStreamEvent(
      createConversationStreamState(bootstrap()),
      delta(1, 0, 4, 'text'),
    ).state;
    const final = reference(2),
      finalEvent = event(2, 'message.changed', { message: final });
    const pending = applyConversationStreamEvent(state, finalEvent);
    expect(pending.status).toBe('resolve-message');
    expect(pending.reference).toEqual(final);
    expect(pending.state.acknowledgedCursor).toBe(cursor(1));
    expect(pending.state.previews[id(200)]).toBeUndefined();
    expect(pending.state.messages[id(500)]).toBeUndefined();
    expect(
      applyConversationStreamEvent(
        pending.state,
        event(3, 'conversation.invalidated', { reason: 'membership' }),
      ).status,
    ).toBe('blocked');
    const resolved = resolveConversationStreamMessage(pending.state, cursor(2), revision(final));
    expect(resolved.status).toBe('applied');
    expect(resolved.state.acknowledgedCursor).toBe(cursor(2));
    expect(resolved.state.messages[id(500)]).toEqual(final);
    expect(applyConversationStreamEvent(resolved.state, finalEvent).status).toBe('duplicate');
    expect(Object.keys(resolved.state.messages)).toEqual([id(500)]);
  });

  it('retries a pending locator after reconnect replays its unacknowledged reference', () => {
    const message = reference(1),
      changed = event(1, 'message.changed', { message });
    const pending = applyConversationStreamEvent(
      createConversationStreamState(bootstrap()),
      changed,
    );
    const replayed = applyConversationStreamEvent(pending.state, changed);
    expect(replayed.status).toBe('resolve-message');
    expect(replayed.reference).toEqual(message);
    expect(replayed.state.acknowledgedSequence).toBe(0);
    const resolved = resolveConversationStreamMessage(replayed.state, cursor(1), revision(message));
    expect(resolved.state.acknowledgedSequence).toBe(1);
    expect(Object.keys(resolved.state.messages)).toEqual([message.messageId]);
  });

  it.each(['more-than-eight', 'expired-prefix', 'byte-budget'] as const)(
    'acknowledges a valid later delta for an omitted %s prefix and converges to one final answer',
    (kind) => {
      const missing = kind === 'expired-prefix' ? 7 : 8;
      const executions = Array.from({ length: missing + 1 }, (_, n) => execution(n));
      const previews =
        kind === 'byte-budget'
          ? [
              {
                taskId: id(100),
                runId: id(200),
                attempt: 1 as const,
                endByte: 262144,
                text: 'x'.repeat(262144),
              },
            ]
          : executions.slice(0, kind === 'expired-prefix' ? 7 : 8).map((run) => ({
              taskId: run.taskId,
              runId: run.runId,
              attempt: 1 as const,
              endByte: 6,
              text: 'prefix',
            }));
      const initial = createConversationStreamState(
        bootstrap({ cursor: cursor(10), executions, previews, previewsTruncated: true }),
      );
      const waiting = applyConversationStreamEvent(initial, delta(11, 20, 25, ' 🌍', missing));
      expect(waiting.status).toBe('applied');
      expect(waiting.state.acknowledgedSequence).toBe(11);
      expect(waiting.state.previews[id(200 + missing)]).toMatchObject({
        status: 'unavailable',
        text: '',
        endByte: 25,
      });
      const more = applyConversationStreamEvent(waiting.state, delta(12, 25, 30, ' more', missing));
      expect(more.status).toBe('applied');
      expect(more.state.previews[id(200 + missing)]?.text).toBe('');
      const final = reference(13, missing);
      const pending = applyConversationStreamEvent(
        more.state,
        event(13, 'message.changed', { message: final }),
      );
      const resolved = resolveConversationStreamMessage(pending.state, cursor(13), revision(final));
      expect(resolved.status).toBe('applied');
      const completed = event(14, 'task.run.updated', {
        execution: {
          ...execution(missing),
          taskStatus: 'completed',
          runStatus: 'completed',
          finishedAt: instant,
          output: { messageId: final.messageId, eventId: final.versionEventId, sequence: 13 },
        },
      });
      const terminal = applyConversationStreamEvent(resolved.state, completed);
      expect(terminal.status).toBe('applied');
      expect(terminal.state.acknowledgedCursor).toBe(cursor(14));
      expect(terminal.state.previews[id(200 + missing)]).toBeUndefined();
      expect(Object.keys(terminal.state.messages)).toEqual([final.messageId]);
      expect(applyConversationStreamEvent(terminal.state, completed).state).toBe(terminal.state);
    },
  );

  it('discards an incomplete prefix after a gap instead of fabricating text or resyncing forever', () => {
    const first = applyConversationStreamEvent(
      createConversationStreamState(bootstrap()),
      delta(1, 0, 2, 'ok'),
    ).state;
    const gap = applyConversationStreamEvent(first, delta(2, 7, 12, 'later'));
    expect(gap.status).toBe('applied');
    expect(gap.state.previews[id(200)]).toMatchObject({
      status: 'unavailable',
      text: '',
      endByte: 12,
    });
    expect(gap.state.acknowledgedSequence).toBe(2);
  });

  it('does not mistake replacement decoding inside a UTF-8 codepoint for an offset replay', () => {
    const first = applyConversationStreamEvent(
      createConversationStreamState(bootstrap()),
      delta(1, 0, 4, '🌍'),
    ).state;
    const overlap = applyConversationStreamEvent(first, delta(2, 0, 3, '�'));
    expect(overlap.state.previews[id(200)]).toMatchObject({ status: 'unavailable', text: '' });
    expect(overlap.state.acknowledgedSequence).toBe(2);
  });

  it('bounds active prefix count, combined UTF-8 bytes and unavailable marker count', () => {
    let state = createConversationStreamState(bootstrap());
    for (let n = 0; n < 80; n++) {
      const result = applyConversationStreamEvent(
        state,
        delta(n + 1, 0, 4096, 'x'.repeat(4096), n),
      );
      expect(result.status).toBe('applied');
      state = result.state;
    }
    const previews = Object.values(state.previews);
    expect(previews.filter((preview) => preview.status === 'streaming')).toHaveLength(8);
    expect(previews.length).toBeLessThanOrEqual(64);
    expect(
      previews.reduce((sum, preview) => sum + new TextEncoder().encode(preview.text).byteLength, 0),
    ).toBeLessThanOrEqual(262144);
    expect(state.acknowledgedSequence).toBe(80);
    let growing = createConversationStreamState(bootstrap());
    for (let n = 0; n < 65; n++)
      growing = applyConversationStreamEvent(
        growing,
        delta(n + 1, n * 4096, (n + 1) * 4096, 'x'.repeat(4096)),
      ).state;
    expect(growing.previews[id(200)]).toMatchObject({
      status: 'unavailable',
      text: '',
      endByte: 266240,
    });
    expect(growing.acknowledgedSequence).toBe(65);
  });

  it('clears a tombstoned cached body immediately but acknowledges only its resolved current tombstone', () => {
    const original = { ...reference(1), taskId: null, runId: null };
    const state = createConversationStreamState(
      bootstrap({ cursor: cursor(1), messages: [original] }),
    );
    const tombstone = { ...original, versionEventId: id(602), sequence: 2, deleted: true };
    const pending = applyConversationStreamEvent(
      state,
      event(2, 'message.changed', { message: tombstone }),
    );
    expect(pending.status).toBe('resolve-message');
    expect(pending.clearMessageId).toBe(original.messageId);
    expect(pending.state.acknowledgedSequence).toBe(1);
    expect(
      resolveConversationStreamMessage(pending.state, cursor(2), {
        ...revision(tombstone),
        deleted: false,
      }).status,
    ).toBe('resync-required');
    const resolved = resolveConversationStreamMessage(
      pending.state,
      cursor(2),
      revision(tombstone),
    );
    expect(resolved.state.messages[original.messageId]?.deleted).toBe(true);
    expect(resolved.state.acknowledgedSequence).toBe(2);
  });

  it('rejects wrong, stale or inconsistent locator results without overwriting a newer revision', () => {
    const message = { ...reference(1), taskId: null, runId: null };
    const pending = applyConversationStreamEvent(
      createConversationStreamState(bootstrap()),
      event(1, 'message.changed', { message }),
    );
    for (const changed of [
      { ...revision(message), id: id(999) },
      { ...revision(message), sequence: 0 },
      { ...revision(message), versionEventId: id(999) },
      { ...revision(message), creationSequence: 2 },
    ]) {
      const rejected = resolveConversationStreamMessage(pending.state, cursor(1), changed);
      expect(rejected.status).toBe('resync-required');
      expect(rejected.state.acknowledgedSequence).toBe(0);
    }
    const newer = { ...revision(message), sequence: 3, versionEventId: id(603) };
    const resolved = resolveConversationStreamMessage(pending.state, cursor(1), newer);
    expect(resolved.status).toBe('applied');
    expect(resolved.state.messages[message.messageId]?.sequence).toBe(3);
    expect(resolved.state.acknowledgedSequence).toBe(1);
  });

  it('does not promote a failed preview into a ledger message or resurrect it from a late delta', () => {
    const initial = createConversationStreamState(bootstrap({ executions: [execution()] }));
    const streaming = applyConversationStreamEvent(initial, delta(1, 0, 7, 'partial')).state;
    const failure = event(2, 'task.run.updated', {
      execution: {
        ...execution(),
        taskStatus: 'failed',
        runStatus: 'failed',
        finishedAt: instant,
        error: 'provider_failed',
      },
    });
    const failed = applyConversationStreamEvent(streaming, failure);
    expect(failed.status).toBe('applied');
    expect(failed.state.previews).toEqual({});
    expect(failed.state.messages).toEqual({});
    const late = applyConversationStreamEvent(failed.state, delta(3, 7, 12, ' late'));
    expect(late.state.previews).toEqual({});
    expect(late.state.messages).toEqual({});
  });

  it('rejects sequence gaps, mismatched run identity and terminal status regression without acknowledgement', () => {
    const initial = createConversationStreamState(bootstrap({ executions: [execution()] }));
    expect(applyConversationStreamEvent(initial, delta(2, 0, 2, 'no')).status).toBe(
      'resync-required',
    );
    const conflicting = event(1, 'assistant.delta', {
      taskId: id(999),
      runId: id(200),
      attempt: 1,
      startByte: 0,
      endByte: 2,
      text: 'no',
    });
    expect(applyConversationStreamEvent(initial, conflicting).status).toBe('resync-required');
    const failed = applyConversationStreamEvent(
      initial,
      event(1, 'task.run.updated', {
        execution: {
          ...execution(),
          taskStatus: 'failed',
          runStatus: 'failed',
          finishedAt: instant,
          error: 'worker_stopped',
        },
      }),
    ).state;
    const regressed = applyConversationStreamEvent(
      failed,
      event(2, 'task.run.updated', { execution: execution() }),
    );
    expect(regressed.status).toBe('resync-required');
    expect(regressed.state.acknowledgedSequence).toBe(1);
  });
});
