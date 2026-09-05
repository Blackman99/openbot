import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryFixture } from '../helpers/memory-fixture.js';
import { AttachmentService } from '../../src/attachments/service.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { MemoryAccessError, MemoryConflictError } from '../../src/memories/types.js';
import {
  BOT_FACT_VISIBILITY_SUMMARY,
  GROUP_FACT_VISIBILITY_SUMMARY,
  WORKSPACE_FACT_VISIBILITY_SUMMARY,
} from '../../src/memories/review-schema.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function extractedGroupCandidate(
  base: Awaited<ReturnType<typeof memoryFixture>>,
  text: string,
  key: string,
  grant?: { id: string },
) {
  const admitted =
    grant ??
    (await base.grants.invite(base.owner.user.id, base.owner.workspace.id, base.group.id, {
      botId: base.bot.id,
      idempotencyKey: `grant-${key}`,
      history: { mode: 'all' },
    }));
  const tasks = new TaskService(base.pool);
  await tasks.submit(base.owner.user.id, base.owner.workspace.id, base.conversation.id, {
    body: 'Extract a candidate.',
    idempotencyKey: `run-${key}`,
    groupGrantId: admitted.id,
  });
  const worker = new TaskWorker(base.pool, {
    secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    createAdapter: () => ({
      generate: async () => ({
        events: [
          { type: 'text', text },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: '',
      }),
    }),
  });
  expect(await worker.runOnce()).toBe(true);
  const row = (
    await base.pool.query<{ id: string; status: string; current_revision: number }>(
      `SELECT c.id,c.status,c.current_revision FROM memory_candidates c
       JOIN tasks t ON t.id=c.origin_task_id WHERE t.conversation_id=$1 ORDER BY c.created_at DESC`,
      [base.conversation.id],
    )
  ).rows[0];
  return {
    grant: admitted,
    tasks,
    worker,
    candidateId: row!.id,
    revision: Number(row!.current_revision),
  };
}

async function extractedDirectCandidate(
  base: Awaited<ReturnType<typeof memoryFixture>>,
  text: string,
  key: string,
) {
  const conversation = await base.conversations.open(base.owner.user.id, base.owner.workspace.id, {
    subject: { kind: 'direct-bot', id: base.bot.id },
  });
  const tasks = new TaskService(base.pool);
  await tasks.submit(base.owner.user.id, base.owner.workspace.id, conversation.id, {
    body: 'Extract a private candidate.',
    idempotencyKey: `direct-run-${key}`,
  });
  const worker = new TaskWorker(base.pool, {
    secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
    createAdapter: () => ({
      generate: async () => ({
        events: [
          { type: 'text', text },
          { type: 'complete', stopReason: 'stop' },
        ],
        raw: '',
      }),
    }),
  });
  expect(await worker.runOnce()).toBe(true);
  const row = (
    await base.pool.query<{
      id: string;
      status: string;
      current_revision: number;
      proposed_scope_kind: string;
      proposed_scope_id: string;
    }>(
      `SELECT c.id,c.status,c.current_revision,c.proposed_scope_kind,c.proposed_scope_id
       FROM memory_candidates c
       JOIN tasks t ON t.id=c.origin_task_id WHERE t.conversation_id=$1 ORDER BY c.created_at DESC`,
      [conversation.id],
    )
  ).rows[0];
  return {
    conversation,
    tasks,
    candidateId: row!.id,
    revision: Number(row!.current_revision),
    proposedScope: { kind: row!.proposed_scope_kind, id: row!.proposed_scope_id },
  };
}

describe('candidate review inbox', () => {
  it('edits then approves a same-group candidate into searchable context and keeps pending text inert', async () => {
    const base = await memoryFixture(cleanup);
    const { grant, tasks, candidateId, revision } = await extractedGroupCandidate(
      base,
      'Remember: pending must stay inert.',
      'approve',
    );
    const access = {
      actorUserId: base.owner.user.id,
      workspaceId: base.owner.workspace.id,
      conversationId: base.conversation.id,
    };
    const listed = await base.memories.listCandidates(access, {});
    expect(listed.candidates).toEqual([
      expect.objectContaining({
        id: candidateId,
        status: 'pending',
        body: 'pending must stay inert.',
        proposedScope: { kind: 'group', id: base.group.id },
      }),
    ]);
    const groupAccess = {
      actorUserId: base.owner.user.id,
      workspaceId: base.owner.workspace.id,
      groupId: base.group.id,
    };
    expect((await base.memories.list(groupAccess, { query: 'pending' }, true)).memories).toEqual(
      [],
    );
    const edited = await base.memories.editCandidate(access, candidateId, {
      expectedRevision: revision,
      body: 'keep the edited evidence.',
    });
    expect(edited).toMatchObject({
      revision: 2,
      body: 'keep the edited evidence.',
      status: 'pending',
    });
    const approved = await base.memories.approveCandidate(access, candidateId, {
      expectedRevision: 2,
      destination: { kind: 'group', id: base.group.id },
      confidence: 0.8,
      idempotencyKey: 'approve-group',
    });
    expect(approved.replayed).toBe(false);
    expect(approved.candidate.status).toBe('approved');
    expect(approved.fact).toMatchObject({
      kind: 'approved_fact',
      text: 'keep the edited evidence.',
      confidenceSource: 'human',
      scope: { kind: 'group', workspaceId: base.owner.workspace.id, id: base.group.id },
    });
    const search = await base.memories.list(groupAccess, { query: 'edited evidence' }, true);
    expect(search.memories).toEqual([
      expect.objectContaining({ kind: 'approved_fact', text: 'keep the edited evidence.' }),
    ]);
    let captured: string[] = [];
    await tasks.submit(base.owner.user.id, base.owner.workspace.id, base.conversation.id, {
      body: 'Use reviewed facts.',
      idempotencyKey: 'after-approve',
      groupGrantId: grant.id,
    });
    const later = new TaskWorker(base.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async (input) => {
          captured = input.messages.map((message) => message.content);
          return {
            events: [
              { type: 'text', text: 'Using the fact.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await later.runOnce()).toBe(true);
    const factContext = captured.find((content) => content.includes('"kind":"approved_facts"'));
    expect(factContext).toContain('keep the edited evidence.');
    expect(factContext).not.toContain('pending must stay inert.');
    expect(captured.some((content) => content.includes('"kind":"group_memories"'))).toBe(false);
    const replay = await base.memories.approveCandidate(access, candidateId, {
      expectedRevision: 2,
      destination: { kind: 'group', id: base.group.id },
      confidence: 0.8,
      idempotencyKey: 'approve-group',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.fact?.id).toBe(approved.fact?.id);
  });

  it('rejects a candidate, ignores extraction replay, and requires confirmation for workspace scope', async () => {
    const base = await memoryFixture(cleanup);
    const first = await extractedGroupCandidate(
      base,
      'Remember: reject this suggestion.',
      'reject',
    );
    const access = {
      actorUserId: base.owner.user.id,
      workspaceId: base.owner.workspace.id,
      conversationId: base.conversation.id,
    };
    const rejected = await base.memories.rejectCandidate(access, first.candidateId, {
      expectedRevision: first.revision,
      idempotencyKey: 'reject-one',
    });
    expect(rejected.candidate.status).toBe('rejected');
    await base.pool.query(
      "UPDATE memory_extraction_jobs SET status='queued',attempt_count=0,claim_token=NULL,lease_expires_at=NULL,last_error_code=NULL",
    );
    expect(await first.worker.runOnce()).toBe(true);
    expect(
      (
        await base.pool.query('SELECT status FROM memory_candidates WHERE id=$1', [
          first.candidateId,
        ])
      ).rows,
    ).toEqual([{ status: 'rejected' }]);
    expect(
      (
        await base.memories.list(
          {
            actorUserId: base.owner.user.id,
            workspaceId: base.owner.workspace.id,
            groupId: base.group.id,
          },
          { query: 'reject this' },
          true,
        )
      ).memories,
    ).toEqual([]);
    const second = await extractedGroupCandidate(
      base,
      'Remember: publish across the workspace.',
      'workspace',
      first.grant,
    );
    await expect(
      base.memories.approveCandidate(access, second.candidateId, {
        expectedRevision: second.revision,
        destination: { kind: 'workspace', id: base.owner.workspace.id },
        confidence: 0.7,
        idempotencyKey: 'need-preview',
      }),
    ).rejects.toBeInstanceOf(MemoryAccessError);
    const preview = await base.memories.previewCandidate(access, second.candidateId, {
      expectedRevision: second.revision,
      destination: { kind: 'workspace', id: base.owner.workspace.id },
      confidence: 0.7,
    });
    expect(preview.preview.visibility.summary).toBe(WORKSPACE_FACT_VISIBILITY_SUMMARY);
    const confirmed = await base.memories.confirmCandidate(access, second.candidateId, {
      intentId: preview.preview.id,
      idempotencyKey: 'confirm-workspace',
      acknowledged: true,
    });
    expect(confirmed.replayed).toBe(false);
    expect(confirmed.fact).toMatchObject({
      kind: 'approved_fact',
      scope: { kind: 'workspace', id: base.owner.workspace.id },
      text: 'publish across the workspace.',
    });
    await expect(
      base.memories.editCandidate(access, first.candidateId, {
        expectedRevision: 1,
        body: 'cannot revive rejection.',
      }),
    ).rejects.toBeInstanceOf(MemoryConflictError);
    const outsider = await base.addUser();
    await expect(
      base.memories.rejectCandidate(
        {
          actorUserId: outsider.id,
          workspaceId: base.owner.workspace.id,
          conversationId: base.conversation.id,
        },
        second.candidateId,
        { expectedRevision: second.revision, idempotencyKey: 'stranger' },
      ),
    ).rejects.toBeInstanceOf(MemoryAccessError);
    const inbox = await base.app.inject({
      url: `/api/v1/workspaces/${base.owner.workspace.id}/conversations/${base.conversation.id}/memory-candidates`,
      headers: base.headers,
    });
    expect(inbox.statusCode).toBe(200);
    expect(
      inbox
        .json()
        .candidates.map((row: { status: string }) => row.status)
        .sort(),
    ).toEqual(['approved', 'rejected']);
  });

  it('requires confirmation for cross-group and Bot destinations and hides source from destination-only readers', async () => {
    const base = await memoryFixture(cleanup);
    const destGroup = await base.groups.create(base.owner.user.id, base.owner.workspace.id, {
      name: 'Reviewed destination',
    });
    const destOnly = await base.addUser();
    await base.groups.addMember(base.owner.user.id, base.owner.workspace.id, destGroup.id, {
      userId: destOnly.id,
      role: 'member',
    });
    await base.conversations.open(base.owner.user.id, base.owner.workspace.id, {
      subject: { kind: 'group', id: destGroup.id },
    });
    const first = await extractedGroupCandidate(
      base,
      'Remember: publish into another group.',
      'cross-group',
    );
    const access = {
      actorUserId: base.owner.user.id,
      workspaceId: base.owner.workspace.id,
      conversationId: base.conversation.id,
    };
    const dest = { kind: 'group' as const, id: destGroup.id };
    await expect(
      base.memories.approveCandidate(access, first.candidateId, {
        expectedRevision: first.revision,
        destination: dest,
        confidence: 0.71,
        idempotencyKey: 'direct-cross-group',
      }),
    ).rejects.toBeInstanceOf(MemoryAccessError);
    const groupPreview = await base.memories.previewCandidate(access, first.candidateId, {
      expectedRevision: first.revision,
      destination: dest,
      confidence: 0.71,
    });
    expect(groupPreview.preview.visibility.summary).toBe(GROUP_FACT_VISIBILITY_SUMMARY);
    const groupApproved = await base.memories.confirmCandidate(access, first.candidateId, {
      intentId: groupPreview.preview.id,
      idempotencyKey: 'confirm-cross-group',
      acknowledged: true,
    });
    expect(groupApproved.fact).toMatchObject({
      kind: 'approved_fact',
      text: 'publish into another group.',
      scope: { kind: 'group', id: destGroup.id },
    });
    expect(groupApproved.fact).not.toHaveProperty('source');
    const destSearch = await base.memories.list(
      {
        actorUserId: destOnly.id,
        workspaceId: base.owner.workspace.id,
        groupId: destGroup.id,
      },
      { query: 'another group' },
      true,
    );
    expect(destSearch.memories).toEqual([
      expect.objectContaining({ kind: 'approved_fact', text: 'publish into another group.' }),
    ]);
    expect(JSON.stringify(destSearch.memories[0])).not.toContain(base.conversation.id);
    await expect(
      base.memories.listCandidates(
        {
          actorUserId: destOnly.id,
          workspaceId: base.owner.workspace.id,
          conversationId: base.conversation.id,
        },
        {},
      ),
    ).rejects.toBeInstanceOf(MemoryAccessError);
    const second = await extractedGroupCandidate(
      base,
      'Remember: keep this with the Bot.',
      'bot-dest',
      first.grant,
    );
    const botDest = { kind: 'bot' as const, id: base.bot.id };
    await expect(
      base.memories.approveCandidate(access, second.candidateId, {
        expectedRevision: second.revision,
        destination: botDest,
        confidence: 0.66,
        idempotencyKey: 'direct-bot',
      }),
    ).rejects.toBeInstanceOf(MemoryAccessError);
    const botPreview = await base.memories.previewCandidate(access, second.candidateId, {
      expectedRevision: second.revision,
      destination: botDest,
      confidence: 0.66,
    });
    expect(botPreview.preview.visibility.summary).toBe(BOT_FACT_VISIBILITY_SUMMARY);
    const botApproved = await base.memories.confirmCandidate(access, second.candidateId, {
      intentId: botPreview.preview.id,
      idempotencyKey: 'confirm-bot',
      acknowledged: true,
    });
    expect(botApproved.fact).toMatchObject({
      kind: 'approved_fact',
      scope: { kind: 'bot', id: base.bot.id },
      text: 'keep this with the Bot.',
    });
    const privateListed = await base.memories.listPrivate(
      {
        actorUserId: base.owner.user.id,
        workspaceId: base.owner.workspace.id,
        botId: base.bot.id,
      },
      { query: 'keep this with the Bot' },
      true,
    );
    expect(privateListed.memories).toEqual([
      expect.objectContaining({ kind: 'approved_fact', text: 'keep this with the Bot.' }),
    ]);
  });

  it('drops an approved fact from search and later context after a bound source edit', async () => {
    const base = await memoryFixture(cleanup);
    const { grant, tasks, candidateId, revision } = await extractedGroupCandidate(
      base,
      'Remember: lineage must stay current.',
      'lineage',
    );
    const access = {
      actorUserId: base.owner.user.id,
      workspaceId: base.owner.workspace.id,
      conversationId: base.conversation.id,
    };
    await base.memories.approveCandidate(access, candidateId, {
      expectedRevision: revision,
      destination: { kind: 'group', id: base.group.id },
      confidence: 0.77,
      idempotencyKey: 'approve-lineage',
    });
    const groupAccess = {
      actorUserId: base.owner.user.id,
      workspaceId: base.owner.workspace.id,
      groupId: base.group.id,
    };
    expect(
      (await base.memories.list(groupAccess, { query: 'lineage must stay' }, true)).memories,
    ).toEqual([
      expect.objectContaining({ kind: 'approved_fact', text: 'lineage must stay current.' }),
    ]);
    await base.conversations.edit(
      base.owner.user.id,
      base.owner.workspace.id,
      base.conversation.id,
      base.source.messageId,
      { expectedVersion: 1, body: 'Changed bound source', idempotencyKey: 'stale-source' },
    );
    expect(
      (await base.memories.list(groupAccess, { query: 'lineage must stay' }, true)).memories,
    ).toEqual([]);
    let captured: string[] = [];
    await tasks.submit(base.owner.user.id, base.owner.workspace.id, base.conversation.id, {
      body: 'Use reviewed facts after the source changed.',
      idempotencyKey: 'after-stale-source',
      groupGrantId: grant.id,
    });
    const later = new TaskWorker(base.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async (input) => {
          captured = input.messages.map((message) => message.content);
          return {
            events: [
              { type: 'text', text: 'No stale fact.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await later.runOnce()).toBe(true);
    expect(captured.some((content) => content.includes('"kind":"approved_facts"'))).toBe(false);
  });

  it('drops an approved fact after a bound source tombstone', async () => {
    const base = await memoryFixture(cleanup);
    const { candidateId, revision } = await extractedGroupCandidate(
      base,
      'Remember: tombstone must hide the fact.',
      'tombstone',
    );
    const access = {
      actorUserId: base.owner.user.id,
      workspaceId: base.owner.workspace.id,
      conversationId: base.conversation.id,
    };
    await base.memories.approveCandidate(access, candidateId, {
      expectedRevision: revision,
      destination: { kind: 'group', id: base.group.id },
      confidence: 0.6,
      idempotencyKey: 'approve-tombstone',
    });
    const groupAccess = {
      actorUserId: base.owner.user.id,
      workspaceId: base.owner.workspace.id,
      groupId: base.group.id,
    };
    expect(
      (await base.memories.list(groupAccess, { query: 'tombstone must hide' }, true)).memories,
    ).toEqual([
      expect.objectContaining({ kind: 'approved_fact', text: 'tombstone must hide the fact.' }),
    ]);
    await base.conversations.tombstone(
      base.owner.user.id,
      base.owner.workspace.id,
      base.conversation.id,
      base.source.messageId,
      { expectedVersion: 1, idempotencyKey: 'tombstone-source' },
    );
    expect(
      (await base.memories.list(groupAccess, { query: 'tombstone must hide' }, true)).memories,
    ).toEqual([]);
  });

  it('drops an approved fact after a bound source purge', async () => {
    const base = await memoryFixture(cleanup);
    const objects = new Map<string, Buffer>();
    const attachments = new AttachmentService(base.pool, {
      identity: 'test-review-objects',
      save: async (key, bytes) => {
        objects.set(key.objectId, Buffer.from(bytes));
      },
      read: async (key) => objects.get(key.objectId)!,
      delete: async (key) => {
        objects.delete(key.objectId);
      },
    });
    const bytes = Buffer.from('Bound attachment source');
    const uploaded = await attachments.upload(
      {
        actorUserId: base.owner.user.id,
        workspaceId: base.owner.workspace.id,
        conversationId: base.conversation.id,
      },
      {
        body: 'Bound attachment source',
        idempotencyKey: 'review-upload',
        filename: 'source.txt',
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      bytes,
    );
    const { candidateId, revision } = await extractedGroupCandidate(
      base,
      'Remember: purge must hide the fact.',
      'purge',
    );
    const access = {
      actorUserId: base.owner.user.id,
      workspaceId: base.owner.workspace.id,
      conversationId: base.conversation.id,
    };
    await base.memories.approveCandidate(access, candidateId, {
      expectedRevision: revision,
      destination: { kind: 'group', id: base.group.id },
      confidence: 0.6,
      idempotencyKey: 'approve-purge',
    });
    const groupAccess = {
      actorUserId: base.owner.user.id,
      workspaceId: base.owner.workspace.id,
      groupId: base.group.id,
    };
    expect(
      (await base.memories.list(groupAccess, { query: 'purge must hide' }, true)).memories,
    ).toEqual([
      expect.objectContaining({ kind: 'approved_fact', text: 'purge must hide the fact.' }),
    ]);
    await attachments.purge(
      {
        actorUserId: base.owner.user.id,
        workspaceId: base.owner.workspace.id,
        conversationId: base.conversation.id,
      },
      uploaded.messageId,
    );
    expect(
      (await base.memories.list(groupAccess, { query: 'purge must hide' }, true)).memories,
    ).toEqual([]);
  });

  it('requires confirmation to publish a direct-conversation candidate onto its origin Bot', async () => {
    const base = await memoryFixture(cleanup);
    const extracted = await extractedDirectCandidate(
      base,
      'Remember: keep this private Bot fact.',
      'direct',
    );
    expect(extracted.proposedScope).toEqual({ kind: 'bot', id: base.bot.id });
    const access = {
      actorUserId: base.owner.user.id,
      workspaceId: base.owner.workspace.id,
      conversationId: extracted.conversation.id,
    };
    const destination = { kind: 'bot' as const, id: base.bot.id };
    await expect(
      base.memories.approveCandidate(access, extracted.candidateId, {
        expectedRevision: extracted.revision,
        destination,
        confidence: 0.64,
        idempotencyKey: 'direct-to-bot',
      }),
    ).rejects.toBeInstanceOf(MemoryAccessError);
    const preview = await base.memories.previewCandidate(access, extracted.candidateId, {
      expectedRevision: extracted.revision,
      destination,
      confidence: 0.64,
    });
    expect(preview.preview.visibility.summary).toBe(BOT_FACT_VISIBILITY_SUMMARY);
    const confirmed = await base.memories.confirmCandidate(access, extracted.candidateId, {
      intentId: preview.preview.id,
      idempotencyKey: 'confirm-direct-bot',
      acknowledged: true,
    });
    expect(confirmed.fact).toMatchObject({
      kind: 'approved_fact',
      scope: { kind: 'bot', id: base.bot.id },
      text: 'keep this private Bot fact.',
    });
    expect(
      (
        await base.memories.listPrivate(
          {
            actorUserId: base.owner.user.id,
            workspaceId: base.owner.workspace.id,
            botId: base.bot.id,
          },
          { query: 'private Bot fact' },
          true,
        )
      ).memories,
    ).toEqual([
      expect.objectContaining({ kind: 'approved_fact', text: 'keep this private Bot fact.' }),
    ]);
    const stranger = await base.addUser();
    await expect(
      base.memories.listCandidates(
        {
          actorUserId: stranger.id,
          workspaceId: base.owner.workspace.id,
          conversationId: extracted.conversation.id,
        },
        {},
      ),
    ).rejects.toBeInstanceOf(MemoryAccessError);
  });
});
