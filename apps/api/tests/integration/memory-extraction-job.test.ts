import { afterEach, describe, expect, it } from 'vitest';
import { taskFixture } from '../helpers/task-fixture.js';
import { memoryFixture } from '../helpers/memory-fixture.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import {
  LOCAL_EXTRACTOR_VERSION,
  LOCAL_NORMALIZER_VERSION,
} from '../../src/memories/extraction-schema.js';

describe('successful-Run extraction enqueue', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it('records exact selected locators and one queued job in the successful completion transaction', async () => {
    const f = await taskFixture(cleanup);
    const worker = f.worker(async () => ({
      events: [
        { type: 'text', text: 'Remember: keep the evidence.' },
        { type: 'complete', stopReason: 'stop' },
      ],
      raw: '',
    }));
    expect(await worker.runOnce()).toBe(true);
    const completed = await f.read();
    expect(completed.status).toBe('completed');
    const runId = completed.runs[0]!.id;
    const outputEventId = completed.runs[0]!.output!.eventId;
    const jobs = (
      await f.pool.query(
        'SELECT run_id,output_event_id,status,extractor_version,normalizer_version,attempt_count FROM memory_extraction_jobs',
      )
    ).rows;
    expect(jobs).toEqual([
      {
        run_id: runId,
        output_event_id: outputEventId,
        status: 'queued',
        extractor_version: LOCAL_EXTRACTOR_VERSION,
        normalizer_version: LOCAL_NORMALIZER_VERSION,
        attempt_count: 0,
      },
    ]);
    const items = (
      await f.pool.query(
        'SELECT position,kind,message_id,creation_event_id,creation_sequence,version_event_id,role,memory_version_id,private_memory_id,source_event_id FROM run_source_manifest_items WHERE run_id=$1 ORDER BY position',
        [runId],
      )
    ).rows;
    expect(items[0]).toMatchObject({
      position: 1,
      kind: 'bot_instructions',
      message_id: null,
      memory_version_id: null,
      private_memory_id: null,
    });
    const trigger = items.find((item) => item.kind === 'message');
    expect(trigger).toMatchObject({
      kind: 'message',
      message_id: f.task.trigger.messageId,
      creation_event_id: f.task.trigger.eventId,
      version_event_id: f.task.trigger.eventId,
      role: 'user',
      memory_version_id: null,
      private_memory_id: null,
      source_event_id: null,
    });
    expect(Number(trigger?.creation_sequence)).toBe(f.task.trigger.sequence);
    expect(JSON.stringify(items)).not.toMatch(/Remember:|Explain the evidence/i);
    expect(
      (await f.pool.query('SELECT digest FROM run_source_manifests WHERE run_id=$1', [runId])).rows,
    ).toHaveLength(1);
  });

  it('includes selected group-memory locators and still enqueues one job', async () => {
    const base = await memoryFixture(cleanup);
    const saved = await base.memories.create(
      {
        actorUserId: base.owner.user.id,
        workspaceId: base.owner.workspace.id,
        groupId: base.group.id,
      },
      base.command,
    );
    const grant = await base.grants.invite(
      base.owner.user.id,
      base.owner.workspace.id,
      base.group.id,
      {
        botId: base.bot.id,
        idempotencyKey: 'all',
        history: { mode: 'all' },
      },
    );
    const tasks = new TaskService(base.pool);
    const task = await tasks.submit(
      base.owner.user.id,
      base.owner.workspace.id,
      base.conversation.id,
      {
        body: 'Answer using the saved group memory.',
        idempotencyKey: 'later-run',
        groupGrantId: grant.id,
      },
    );
    const worker = new TaskWorker(base.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      createAdapter: () => ({
        generate: async () => ({
          events: [
            { type: 'text', text: 'Cobalt is the saved code.' },
            { type: 'complete', stopReason: 'stop' },
          ],
          raw: '',
        }),
      }),
    });
    expect(await worker.runOnce()).toBe(true);
    const runId = task.runs[0]!.id;
    expect(
      (
        await base.pool.query(
          "SELECT kind,memory_version_id,source_event_id FROM run_source_manifest_items WHERE run_id=$1 AND kind='group_memory'",
          [runId],
        )
      ).rows,
    ).toEqual([
      {
        kind: 'group_memory',
        memory_version_id: saved.memory.versionId,
        source_event_id: base.source.eventId,
      },
    ]);
    expect(
      (await base.pool.query('SELECT status FROM memory_extraction_jobs WHERE run_id=$1', [runId]))
        .rows,
    ).toEqual([{ status: 'queued' }]);
    expect(
      JSON.stringify(
        (await base.pool.query('SELECT * FROM run_source_manifest_items WHERE run_id=$1', [runId]))
          .rows,
      ),
    ).not.toContain('cobalt');
  });

  it('does not enqueue an extraction job when the Run fails', async () => {
    const f = await taskFixture(cleanup);
    const worker = f.worker(async () => ({
      events: [{ type: 'text', text: 'Partial draft.' }],
      raw: '',
      error: { code: 'provider_failed', category: 'retryable' },
    }));
    expect(await worker.runOnce()).toBe(true);
    expect(await f.read()).toMatchObject({
      status: 'failed',
      runs: [{ error: 'provider_failed' }],
    });
    expect((await f.pool.query('SELECT run_id FROM memory_extraction_jobs')).rows).toEqual([]);
  });
});
