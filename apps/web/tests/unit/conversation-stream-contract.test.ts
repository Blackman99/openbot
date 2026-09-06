import { describe, expect, it } from 'vitest';
import {
  encodeConversationStreamCursor,
  parseConversationStreamCursor,
  parseConversationStreamEvent,
  parseConversationStreamBootstrap,
  parseExecutionState,
  parseMessageReference,
} from '../../src/lib/conversation-stream-contract.js';

const scope = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  conversationId: '22222222-2222-4222-8222-222222222222',
};
const messageId = '33333333-3333-4333-8333-333333333333';
const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const taskId = '55555555-5555-4555-8555-555555555555';
const runId = '66666666-6666-4666-8666-666666666666';
const instant = '2030-01-01T00:00:00.000Z';
const base64url = (text: string) =>
  btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
const cursor = (after: number) => base64url(JSON.stringify({ v: 1, ...scope, after }));
const reference = () => ({
  messageId,
  creationSequence: 1,
  versionEventId: eventId,
  sequence: 2,
  deleted: false,
  taskId: null,
  runId: null,
});
const execution = () => ({
  taskId,
  runId,
  attempt: 1,
  taskStatus: 'running',
  runStatus: 'running',
  bot: { id: messageId, displayName: 'Assistant', versionId: eventId, versionNumber: 1 },
  executionUser: { id: scope.workspaceId, displayName: 'Viewer' },
  createdAt: instant,
  startedAt: instant,
  finishedAt: null,
  provider: { protocol: 'openai-chat', modelId: 'model-1' },
  usage: null,
  error: null,
  output: null,
});
const envelope = (data: unknown, type = 'assistant.delta') => ({
  schemaVersion: 1,
  cursor: cursor(3),
  conversationId: scope.conversationId,
  sequence: 3,
  occurredAt: instant,
  type,
  data,
});
const bootstrap = () => ({
  schemaVersion: 1,
  cursor: cursor(3),
  conversationId: scope.conversationId,
  messages: [reference()],
  nextMessageCursor: null,
  executions: [execution()],
  nextTaskCursor: null,
  previews: [{ taskId, runId, attempt: 1, endByte: 6, text: 'hi 🌍' }],
  previewsTruncated: false,
});

describe('conversation stream wire contract', () => {
  it('preserves only the optional small routing summary in strict events and bootstrap', () => {
    for (const reason of ['mention', 'default', 'local-match']) {
      const state = { ...execution(), routing: { algorithm: 'local-terms-v1', reason } };
      expect(parseExecutionState(state)).toEqual(state);
      const snapshot = { ...bootstrap(), executions: [state], previews: [] };
      expect(parseConversationStreamBootstrap(JSON.stringify(snapshot), scope)).toEqual(snapshot);
      const event = envelope({ execution: state }, 'task.run.updated');
      expect(parseConversationStreamEvent(event, scope)).toEqual(event);
    }
    for (const routing of [
      { algorithm: 'other', reason: 'mention' },
      { algorithm: 'local-terms-v1', reason: 'unknown' },
      { algorithm: 'local-terms-v1', reason: 'mention', candidates: [] },
      null,
    ])
      expect(parseExecutionState({ ...execution(), routing })).toBeUndefined();
    expect(parseExecutionState(execution())).toEqual(execution());
  });

  it('encodes a scoped canonical cursor and accepts both inclusive numeric bounds', () => {
    for (const after of [0, Number.MAX_SAFE_INTEGER]) {
      expect(encodeConversationStreamCursor(scope, after)).toBe(cursor(after));
      expect(parseConversationStreamCursor(cursor(after), scope)).toEqual({
        v: 1,
        ...scope,
        after,
      });
    }
  });

  it.each([
    () => cursor(2) + '=',
    () => base64url(JSON.stringify({ ...scope, v: 1, after: 2 })),
    () => base64url(JSON.stringify({ v: 1, ...scope, after: 2 }) + ' '),
    () => base64url(JSON.stringify({ v: 1, ...scope, after: 2, token: 'secret' })),
    () => base64url(JSON.stringify({ v: 2, ...scope, after: 2 })),
    () => base64url(JSON.stringify({ v: 1, ...scope, after: -1 })),
    () => base64url(JSON.stringify({ v: 1, ...scope, after: 1.5 })),
    () => base64url(JSON.stringify({ v: 1, ...scope, after: Number.MAX_SAFE_INTEGER + 1 })),
    () => base64url(JSON.stringify({ v: 1, ...scope, conversationId: messageId, after: 2 })),
    () => base64url(JSON.stringify({ v: 1, ...scope, workspaceId: messageId, after: 2 })),
    () => 'a'.repeat(513),
  ])('rejects malformed, noncanonical and wrong-resource cursor %#', (invalid) => {
    expect(parseConversationStreamCursor(invalid(), scope)).toBeUndefined();
  });

  it('accepts exact current references while rejecting captured bodies and partial Bot provenance', () => {
    expect(parseMessageReference(reference())).toEqual(reference());
    for (const changed of [
      { ...reference(), body: 'stale body' },
      { ...reference(), sequence: 0 },
      { ...reference(), sequence: 1, creationSequence: 2 },
      { ...reference(), taskId },
      { ...reference(), versionEventId: eventId.toUpperCase() },
    ])
      expect(parseMessageReference(changed)).toBeUndefined();
    expect(parseMessageReference({ ...reference(), taskId, runId })).toMatchObject({
      taskId,
      runId,
    });
  });

  it('requires one coherent safe execution state with exact status nullability', () => {
    expect(parseExecutionState(execution())).toEqual(execution());
    expect(
      parseExecutionState({
        ...execution(),
        taskStatus: 'queued',
        runStatus: 'queued',
        startedAt: null,
        provider: null,
      }),
    ).toBeDefined();
    expect(
      parseExecutionState({
        ...execution(),
        taskStatus: 'failed',
        runStatus: 'failed',
        startedAt: null,
        provider: null,
        finishedAt: instant,
        error: 'execution_forbidden',
      }),
    ).toBeDefined();
    expect(
      parseExecutionState({
        ...execution(),
        taskStatus: 'failed',
        runStatus: 'failed',
        startedAt: instant,
        finishedAt: instant,
        error: 'worker_interrupted',
      }),
    ).toEqual({
      ...execution(),
      taskStatus: 'failed',
      runStatus: 'failed',
      startedAt: instant,
      finishedAt: instant,
      error: 'worker_interrupted',
    });
    expect(
      parseExecutionState({
        ...execution(),
        taskStatus: 'completed',
        runStatus: 'completed',
        finishedAt: instant,
        output: { messageId, eventId, sequence: 2 },
      }),
    ).toBeDefined();
    for (const changed of [
      { ...execution(), taskStatus: 'queued' },
      { ...execution(), attempt: 0 },
      { ...execution(), startedAt: null },
      { ...execution(), finishedAt: instant },
      {
        ...execution(),
        provider: { ...execution().provider, endpoint: 'https://private.example' },
      },
      { ...execution(), usage: { inputTokens: -1, outputTokens: 0 } },
      { ...execution(), error: 'raw_provider_secret' },
      { ...execution(), runs: [execution()] },
      { ...execution(), taskStatus: 'completed', runStatus: 'completed', finishedAt: instant },
      { ...execution(), taskStatus: 'failed', runStatus: 'failed', finishedAt: instant },
    ])
      expect(parseExecutionState(changed)).toBeUndefined();
  });

  it('requires matching envelope identity and normalized UTF-8 byte offsets', () => {
    const data = { taskId, runId, attempt: 1, startByte: 0, endByte: 7, text: 'hi 🌍' };
    expect(parseConversationStreamEvent(envelope(data), scope)).toEqual(envelope(data));
    for (const changed of [
      envelope({ ...data, endByte: 5 }),
      envelope({ ...data, text: '' }),
      envelope({ ...data, text: 'x'.repeat(4097), endByte: 4097 }),
      envelope({ ...data, text: '\ud800', endByte: 3 }),
      envelope({ ...data, credential: 'secret' }),
      { ...envelope(data), sequence: 4 },
      { ...envelope(data), conversationId: messageId },
      envelope(data, 'unknown.event'),
      { ...envelope(data), occurredAt: 'not-a-date' },
    ])
      expect(parseConversationStreamEvent(changed, scope)).toBeUndefined();
    expect(
      parseConversationStreamEvent(
        envelope({ message: { ...reference(), sequence: 4 } }, 'message.changed'),
        scope,
      ),
    ).toBeDefined();
    expect(
      parseConversationStreamEvent(
        envelope({ reason: 'membership' }, 'conversation.invalidated'),
        scope,
      ),
    ).toBeDefined();
    const warning = {
      taskId,
      dimension: 'turns',
      used: 1,
      limit: 1,
      source: 'workspace',
      soft: true,
      hard: true,
      body: 'Turn usage reached the 1 turns workspace limit.',
    };
    expect(parseConversationStreamEvent(envelope(warning, 'task.limit.warning'), scope)).toEqual(
      envelope(warning, 'task.limit.warning'),
    );
    const tokenWarning = {
      taskId,
      dimension: 'totalTokens',
      used: 32,
      limit: 40,
      source: 'workspace',
      soft: true,
      hard: false,
      body: 'Token usage reached 80% of the 40 total workspace limit.',
    };
    expect(
      parseConversationStreamEvent(envelope(tokenWarning, 'task.limit.warning'), scope),
    ).toEqual(envelope(tokenWarning, 'task.limit.warning'));
  });

  it('accepts positive safe persisted attempts without adding run history', () => {
    for (const attempt of [2, Number.MAX_SAFE_INTEGER]) {
      const run = { ...execution(), attempt };
      const delta = { taskId, runId, attempt, startByte: 0, endByte: 1, text: 'x' };
      const snapshot = {
        ...bootstrap(),
        executions: [run],
        previews: [{ taskId, runId, attempt, endByte: 1, text: 'x' }],
      };
      expect(parseExecutionState(run)?.attempt).toBe(attempt);
      expect(
        parseConversationStreamEvent(envelope({ execution: run }, 'task.run.updated'), scope),
      ).toBeDefined();
      expect(parseConversationStreamEvent(envelope(delta), scope)).toBeDefined();
      expect(
        parseConversationStreamBootstrap(JSON.stringify(snapshot), scope)?.previews[0]?.attempt,
      ).toBe(attempt);
    }
    for (const attempt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseExecutionState({ ...execution(), attempt })).toBeUndefined();
      expect(
        parseConversationStreamEvent(
          envelope({ taskId, runId, attempt, startByte: 0, endByte: 1, text: 'x' }),
          scope,
        ),
      ).toBeUndefined();
      expect(
        parseConversationStreamBootstrap(
          JSON.stringify({
            ...bootstrap(),
            previews: [{ taskId, runId, attempt, endByte: 1, text: 'x' }],
          }),
          scope,
        ),
      ).toBeUndefined();
    }
  });

  it('parses a bounded atomic bootstrap and rejects aggregate, duplicate and preview-prefix violations', () => {
    const valid = {
      ...bootstrap(),
      previews: [{ taskId, runId, attempt: 1, endByte: 7, text: 'hi 🌍' }],
    };
    expect(parseConversationStreamBootstrap(JSON.stringify(valid), scope)).toEqual(valid);
    expect(
      parseConversationStreamBootstrap(new TextEncoder().encode(JSON.stringify(valid)), scope),
    ).toEqual(valid);
    for (const changed of [
      { ...valid, messages: [reference(), reference()] },
      { ...valid, executions: [execution(), execution()] },
      { ...valid, previews: bootstrap().previews },
      { ...valid, previews: Array.from({ length: 9 }, () => valid.previews[0]) },
      { ...valid, previews: [{ ...valid.previews[0], endByte: 262145, text: 'x'.repeat(262145) }] },
      { ...valid, secret: 'forbidden' },
      { ...valid, nextTaskCursor: 'bad cursor' },
      { ...valid, messages: [{ ...reference(), sequence: 4 }] },
    ])
      expect(parseConversationStreamBootstrap(JSON.stringify(changed), scope)).toBeUndefined();
    expect(parseConversationStreamBootstrap(' '.repeat(1048577), scope)).toBeUndefined();
    expect(parseConversationStreamBootstrap(new Uint8Array([0xff]), scope)).toBeUndefined();
  });

  it('accepts eight prefixes totaling 256 KiB but rejects combined bytes or a ninth distinct run', () => {
    const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
    const previews = Array.from({ length: 8 }, (_, i) => ({
      taskId: id(100 + i),
      runId: id(200 + i),
      attempt: 1,
      endByte: 32768,
      text: 'x'.repeat(32768),
    }));
    const exact = { ...bootstrap(), executions: [], previews };
    expect(parseConversationStreamBootstrap(JSON.stringify(exact), scope)?.previews).toHaveLength(
      8,
    );
    expect(
      parseConversationStreamBootstrap(
        JSON.stringify({
          ...exact,
          previews: previews.map((item, i) =>
            i === 0 ? { ...item, endByte: item.endByte + 1, text: item.text + 'x' } : item,
          ),
        }),
        scope,
      ),
    ).toBeUndefined();
    expect(
      parseConversationStreamBootstrap(
        JSON.stringify({
          ...exact,
          previews: Array.from({ length: 9 }, (_, i) => ({
            taskId: id(100 + i),
            runId: id(200 + i),
            attempt: 1,
            endByte: 1,
            text: 'x',
          })),
        }),
        scope,
      ),
    ).toBeUndefined();
  });

  it('counts encoded JSON bytes even when escaped preview text fits the prefix limit', () => {
    const value = {
      ...bootstrap(),
      previews: [{ taskId, runId, attempt: 1, endByte: 200000, text: '\u0000'.repeat(200000) }],
    };
    expect(new TextEncoder().encode(value.previews[0]!.text).byteLength).toBeLessThan(262144);
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(1048576);
    expect(parseConversationStreamBootstrap(JSON.stringify(value), scope)).toBeUndefined();
  });
});
