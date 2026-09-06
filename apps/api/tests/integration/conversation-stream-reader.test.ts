import { afterEach, describe, expect, it } from 'vitest';
import { taskFixture } from '../helpers/task-fixture.js';
import { ConversationStreamService } from '../../src/conversations/stream-service.js';
import { encodeConversationStreamCursor } from '../../src/conversations/stream-protocol.js';
import { TaskQueue } from '../../src/tasks/queue.js';
import { ConversationStreamDecoder } from '../../../web/src/lib/conversation-stream-codec.js';
import { parseConversationStreamBootstrap } from '../../../web/src/lib/conversation-stream-contract.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('current-authority durable conversation reader', () => {
  it.each(['utf8', 'json-escape'] as const)(
    'enforces the aggregate %s bootstrap budget across active Runs',
    async (kind) => {
      const f = await taskFixture(cleanup),
        stream = new ConversationStreamService(f.pool),
        queue = new TaskQueue(f.pool);
      const scope = { workspaceId: f.owner.workspace.id, conversationId: f.conversation.id };
      const token = f.headers.cookie.split('=')[1]!;
      // Each Run stays within the worker's 32,000-character output limit.
      // Three UTF-8 prefixes exceed the text budget; six escaped prefixes exceed JSON.
      const chunk = kind === 'utf8' ? '漢'.repeat(1000) : '\u0001'.repeat(4000);
      const runCount = kind === 'utf8' ? 3 : 6;
      const parts = kind === 'utf8' ? 32 : 8;
      const endByte = parts * Buffer.byteLength(chunk);
      for (let run = 0; run < runCount; run++) {
        if (run)
          await f.tasks.submit(f.owner.user.id, scope.workspaceId, scope.conversationId, {
            idempotencyKey: `budget-${run}`,
            body: `Budget ${run}`,
          });
        const claim = (await queue.claimNext()).claim!;
        for (let part = 0; part < parts; part++) await queue.publishDelta(claim, chunk);
      }
      const snapshot = await stream.bootstrap(token, scope);
      expect(snapshot.executions).toHaveLength(runCount);
      expect(snapshot.previews).toHaveLength(kind === 'utf8' ? 2 : 5);
      expect(snapshot.previewsTruncated).toBe(true);
      expect(
        snapshot.previews.every(
          (preview) => preview.endByte === endByte && Buffer.byteLength(preview.text) === endByte,
        ),
      ).toBe(true);
      expect(
        snapshot.previews.reduce((bytes, preview) => bytes + Buffer.byteLength(preview.text), 0),
      ).toBeLessThanOrEqual(256 * 1024);
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(1024 * 1024);
      expect(parseConversationStreamBootstrap(JSON.stringify(snapshot), scope)).toEqual(snapshot);
    },
    20000,
  );

  it('bounds aggregate active preview text and the encoded bootstrap without inventing omitted prefixes', async () => {
    const f = await taskFixture(cleanup),
      stream = new ConversationStreamService(f.pool),
      queue = new TaskQueue(f.pool);
    const token = f.headers.cookie.split('=')[1]!,
      scope = { workspaceId: f.owner.workspace.id, conversationId: f.conversation.id };
    const claims = [];
    for (let i = 0; i < 9; i++) {
      if (i)
        await f.tasks.submit(f.owner.user.id, scope.workspaceId, scope.conversationId, {
          idempotencyKey: `preview-${i}`,
          body: `Preview ${i}`,
        });
      const claim = (await queue.claimNext()).claim!;
      claims.push(claim);
      await queue.publishDelta(claim, 'x');
    }
    const bootstrap = await stream.bootstrap(token, scope);
    expect(parseConversationStreamBootstrap(JSON.stringify(bootstrap), scope)).toEqual(bootstrap);
    expect(bootstrap.executions).toHaveLength(9);
    expect(bootstrap.previews).toHaveLength(8);
    expect(bootstrap.previewsTruncated).toBe(true);
    expect(
      bootstrap.previews.every((preview) => preview.text === 'x' && preview.endByte === 1),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bootstrap))).toBeLessThanOrEqual(1024 * 1024);
    // A later delta for the omitted Run preserves its real byte offset. The
    // client can acknowledge it while explicitly awaiting the final locator.
    const omitted = claims.find(
      (claim) => !bootstrap.previews.some((preview) => preview.runId === claim.runId),
    )!;
    await queue.publishDelta(omitted, 'later');
    const frames: string[] = [];
    await stream.deliver(token, scope, bootstrap.cursor, (frame) => frames.push(frame));
    expect(frames[0]).toContain('"startByte":1');
    expect(frames[0]).toContain('"text":"later"');
    expect(new ConversationStreamDecoder(scope).feed(Buffer.from(frames[0]!))).toHaveLength(1);
  }, 15000);

  it('reclaims only the expired delivery prefix and recovers at its durable floor without deleting history', async () => {
    let now = new Date();
    const f = await taskFixture(cleanup, () => now),
      stream = new ConversationStreamService(f.pool, () => now);
    const token = f.headers.cookie.split('=')[1]!,
      scope = { workspaceId: f.owner.workspace.id, conversationId: f.conversation.id };
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    const next = await f.conversations.append(
      f.owner.user.id,
      scope.workspaceId,
      scope.conversationId,
      { idempotencyKey: 'after-retention', body: 'Still durable' },
    );
    const state = (
      await f.pool.query('SELECT * FROM conversation_delivery_state WHERE conversation_id=$1', [
        scope.conversationId,
      ])
    ).rows[0];
    expect(Number(state.floor)).toBe(2);
    expect(Number(state.retained_count)).toBe(1);
    await expect(
      stream.check(token, scope, encodeConversationStreamCursor(scope, 0)),
    ).rejects.toMatchObject({ code: 'cursor_expired', statusCode: 410 });
    expect(await stream.check(token, scope, encodeConversationStreamCursor(scope, 2))).toBe(
      encodeConversationStreamCursor(scope, 2),
    );
    const snapshot = await stream.bootstrap(token, scope);
    expect(snapshot.cursor).toBe(encodeConversationStreamCursor(scope, next.sequence));
    expect(snapshot.messages.map((message) => message.messageId)).toEqual([
      f.task.trigger.messageId,
      next.messageId,
    ]);
    expect(
      (await f.pool.query('SELECT id FROM tasks WHERE conversation_id=$1', [scope.conversationId]))
        .rows,
    ).toHaveLength(1);
  });
  it('bootstraps one atomic high-water mark and replays old message references as current revisions', async () => {
    const f = await taskFixture(cleanup),
      stream = new ConversationStreamService(f.pool);
    const token = f.headers.cookie.split('=')[1]!,
      scope = { workspaceId: f.owner.workspace.id, conversationId: f.conversation.id };
    const bootstrap = await stream.bootstrap(token, scope);
    expect(bootstrap).toMatchObject({
      schemaVersion: 1,
      cursor: encodeConversationStreamCursor(scope, 2),
      messages: [{ messageId: f.task.trigger.messageId }],
      executions: [{ taskId: f.task.id, runStatus: 'queued' }],
      previews: [],
      previewsTruncated: false,
    });
    expect(JSON.stringify(bootstrap)).not.toContain('Explain the evidence');
    const edit = await f.conversations.edit(
      f.owner.user.id,
      scope.workspaceId,
      scope.conversationId,
      f.task.trigger.messageId,
      { idempotencyKey: 'edit-trigger', expectedVersion: 1, body: 'Replacement text' },
    );
    const frames: string[] = [];
    const delivered = await stream.deliver(
      token,
      scope,
      encodeConversationStreamCursor(scope, 0),
      (frame) => frames.push(frame),
    );
    expect(delivered).toEqual({
      cursor: encodeConversationStreamCursor(scope, 1),
      delivered: true,
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain(edit.eventId);
    expect(frames[0]).not.toMatch(/Explain the evidence|Replacement text/u);
    const deletion = await f.conversations.tombstone(
      f.owner.user.id,
      scope.workspaceId,
      scope.conversationId,
      f.task.trigger.messageId,
      { idempotencyKey: 'delete-trigger', expectedVersion: 2 },
    );
    const deletedFrames: string[] = [];
    await stream.deliver(token, scope, encodeConversationStreamCursor(scope, 0), (frame) =>
      deletedFrames.push(frame),
    );
    expect(deletedFrames[0]).toContain('"deleted":true');
    expect(deletedFrames[0]).toContain(deletion.eventId);
  });

  it('rechecks current session and conversation authority before exposing cursor details or delivering', async () => {
    const f = await taskFixture(cleanup),
      stream = new ConversationStreamService(f.pool);
    const token = f.headers.cookie.split('=')[1]!,
      scope = { workspaceId: f.owner.workspace.id, conversationId: f.conversation.id };
    const cursor = await stream.check(token, scope, encodeConversationStreamCursor(scope, 0));
    const outsider = await f.addUser();
    await expect(
      stream.check(outsider.headers.cookie.split('=')[1]!, scope, 'malformed'),
    ).rejects.toMatchObject({ code: 'conversation_forbidden', statusCode: 403 });
    await expect(stream.check('invalid-session', scope, 'malformed')).rejects.toMatchObject({
      code: 'authentication_required',
      statusCode: 401,
    });
    await f.pool.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [
      scope.workspaceId,
      f.owner.user.id,
    ]);
    const frames: string[] = [];
    await expect(
      stream.deliver(token, scope, cursor, (frame) => frames.push(frame)),
    ).rejects.toMatchObject({ code: 'conversation_forbidden', statusCode: 403 });
    expect(frames).toEqual([]);
  });
});
