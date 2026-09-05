import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentService } from '../../src/attachments/service.js';
import { buildApp } from '../../src/app.js';
import { KnowledgeService } from '../../src/knowledge/service.js';
import { LocalObjectStore } from '../../src/objects/local-store.js';
import { ProviderSecretBox } from '../../src/providers/secrets.js';
import { ConversationService } from '../../src/conversations/service.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskWorker } from '../../src/tasks/worker.js';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';
import { imageAttachmentMeta, knowledgePng } from '../helpers/image-bytes.js';
import type { ModelInput } from '../../src/providers/model-events.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function envelope(command: unknown, content: Buffer) {
  const json = Buffer.from(JSON.stringify(command));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  return Buffer.concat([size, json, content]);
}

async function fixture(vision = false) {
  const f = await botAclFixture(cleanup);
  if (vision) {
    const current = await f.providers.capabilities(f.owner.user.id, f.model.id);
    await f.providers.override(f.owner.user.id, f.model.id, {
      expectedRevision: current.revision,
      capability: 'visionInput',
      value: true,
      rationale: 'IMG-01 vision catalog for authorized image delivery',
    });
  }
  const conversations = new ConversationService(new PostgresConversationRepository(f.pool));
  const conversation = await conversations.open(f.owner.user.id, f.owner.workspace.id, {
    subject: { kind: 'direct-bot', id: f.bot.id },
  });
  const root = await mkdtemp(join(tmpdir(), 'openbot-img-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const objects = new LocalObjectStore(root, { maxObjectBytes: 10 * 1024 * 1024 });
  const attachments = new AttachmentService(f.pool, objects);
  const knowledge = new KnowledgeService(f.pool, attachments);
  const app = buildApp({
    auth: f.auth,
    conversations,
    attachments,
    knowledge,
    readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
  });
  cleanup.push(() => app.close());
  return {
    ...f,
    app,
    conversation,
    objects,
    base: `/api/v1/workspaces/${f.owner.workspace.id}/conversations/${conversation.id}`,
  };
}

async function uploadImage(f: Awaited<ReturnType<typeof fixture>>, key: string) {
  const uploaded = await f.app.inject({
    method: 'POST',
    url: `${f.base}/attachments`,
    headers: { ...f.headers, 'content-type': 'application/octet-stream' },
    payload: envelope(
      imageAttachmentMeta(knowledgePng, 'photo.png', 'image/png', key),
      knowledgePng,
    ),
  });
  expect(uploaded.statusCode).toBe(200);
  return uploaded.json().receipt.messageId as string;
}

describe('IMG-01 authorized vision images', () => {
  it('sends a current-message image only to a vision-capable catalog and fails otherwise', async () => {
    const vision = await fixture(true);
    await uploadImage(vision, 'vision-current');
    const tasks = new TaskService(vision.pool);
    await tasks.submit(vision.owner.user.id, vision.owner.workspace.id, vision.conversation.id, {
      idempotencyKey: 'vision-ok',
      body: 'What is in the photo?',
    });
    const sent: ModelInput['messages'] = [];
    const worker = new TaskWorker(vision.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      objects: vision.objects,
      createAdapter: () => ({
        generate: async (input) => {
          sent.push(...input.messages);
          return {
            events: [
              { type: 'text', text: 'I can see the photo.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await worker.runOnce()).toBe(true);
    expect(
      sent.some((message) => message.images?.some((image) => image.bytes.equals(knowledgePng))),
    ).toBe(true);
    const blocked = await fixture(false);
    await uploadImage(blocked, 'no-vision-current');
    const blockedTasks = new TaskService(blocked.pool);
    const blockedTask = await blockedTasks.submit(
      blocked.owner.user.id,
      blocked.owner.workspace.id,
      blocked.conversation.id,
      { idempotencyKey: 'vision-denied', body: 'What is in the photo?' },
    );
    let called = false;
    const denied = new TaskWorker(blocked.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      objects: blocked.objects,
      createAdapter: () => ({
        generate: async () => {
          called = true;
          return { events: [{ type: 'complete', stopReason: 'stop' }], raw: '' };
        },
      }),
    });
    expect(await denied.runOnce()).toBe(true);
    expect(called).toBe(false);
    expect(
      (
        await blockedTasks.get(
          blocked.owner.user.id,
          blocked.owner.workspace.id,
          blocked.conversation.id,
          blockedTask.id,
        )
      ).runs[0],
    ).toMatchObject({
      status: 'failed',
      error: 'model_unavailable',
    });
  });

  it('promotes an image only with a confirmed description and attaches the original only for vision', async () => {
    const vision = await fixture(true);
    const messageId = await uploadImage(vision, 'promote-image');
    const preview = await vision.app.inject({
      method: 'POST',
      url: `${vision.base}/messages/${messageId}/knowledge/preview`,
      headers: vision.headers,
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview).toMatchObject({ kind: 'image', chunks: [] });
    expect(
      (
        await vision.app.inject({
          method: 'POST',
          url: `${vision.base}/messages/${messageId}/knowledge/promotions`,
          headers: vision.headers,
          payload: {
            destination: { kind: 'bot', id: vision.bot.id },
            idempotencyKey: 'image-no-desc',
            acknowledged: true,
          },
        })
      ).json(),
    ).toEqual({ error: { code: 'image_description_required' } });
    const promoted = await vision.app.inject({
      method: 'POST',
      url: `${vision.base}/messages/${messageId}/knowledge/promotions`,
      headers: vision.headers,
      payload: {
        destination: { kind: 'bot', id: vision.bot.id },
        idempotencyKey: 'image-desc',
        acknowledged: true,
        title: 'Cobalt photo',
        description: 'Keep the cobalt key',
      },
    });
    expect(promoted.statusCode).toBe(201);
    expect(
      (
        await vision.pool.query(
          'SELECT extractor_version,text FROM knowledge_documents d JOIN knowledge_chunks c ON c.document_id=d.id',
        )
      ).rows,
    ).toEqual([
      { extractor_version: 'image-description-v1', text: 'Cobalt photo\nKeep the cobalt key' },
    ]);
    const tasks = new TaskService(vision.pool);
    await tasks.submit(vision.owner.user.id, vision.owner.workspace.id, vision.conversation.id, {
      idempotencyKey: 'cite-photo',
      body: 'What is the cobalt photo?',
    });
    const sent: ModelInput['messages'] = [];
    const worker = new TaskWorker(vision.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      objects: vision.objects,
      createAdapter: () => ({
        generate: async (input) => {
          sent.push(...input.messages);
          return {
            events: [
              { type: 'text', text: 'The confirmed description names the cobalt key.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await worker.runOnce()).toBe(true);
    const knowledge = sent.find((message) => message.content.includes('"kind":"scoped_knowledge"'));
    expect(knowledge?.content).toContain('Keep the cobalt key');
    expect(knowledge?.images?.[0]?.bytes.equals(knowledgePng)).toBe(true);
    const textOnly = await fixture(false);
    const textMessage = await uploadImage(textOnly, 'text-only-image');
    expect(
      (
        await textOnly.app.inject({
          method: 'POST',
          url: `${textOnly.base}/messages/${textMessage}/knowledge/promotions`,
          headers: textOnly.headers,
          payload: {
            destination: { kind: 'bot', id: textOnly.bot.id },
            idempotencyKey: 'image-text-only',
            acknowledged: true,
            title: 'Cobalt photo',
            description: 'Keep the cobalt key',
          },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await textOnly.app.inject({
          method: 'POST',
          url: `${textOnly.base}/messages`,
          headers: textOnly.headers,
          payload: {
            idempotencyKey: 'after-photo',
            body: 'Later I will ask about the stored photo.',
          },
        })
      ).statusCode,
    ).toBe(200);
    const textTasks = new TaskService(textOnly.pool);
    await textTasks.submit(
      textOnly.owner.user.id,
      textOnly.owner.workspace.id,
      textOnly.conversation.id,
      {
        idempotencyKey: 'cite-text-only',
        body: 'What is the cobalt photo?',
      },
    );
    const later: ModelInput['messages'] = [];
    const laterWorker = new TaskWorker(textOnly.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      objects: textOnly.objects,
      createAdapter: () => ({
        generate: async (input) => {
          later.push(...input.messages);
          return {
            events: [
              { type: 'text', text: 'Only the confirmed description is available.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await laterWorker.runOnce()).toBe(true);
    const payload = later.find((message) => message.content.includes('"kind":"scoped_knowledge"'));
    expect(payload?.content).toContain('Keep the cobalt key');
    expect(payload?.images).toBeUndefined();
  });

  it('omits purged image attachments from current turns and knowledge retrieval', async () => {
    const blocked = await fixture(false);
    const currentId = await uploadImage(blocked, 'purged-current');
    expect(
      (
        await blocked.app.inject({
          method: 'POST',
          url: `${blocked.base}/messages/${currentId}/purge`,
          headers: blocked.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(202);
    const blockedTasks = new TaskService(blocked.pool);
    const blockedTask = await blockedTasks.submit(
      blocked.owner.user.id,
      blocked.owner.workspace.id,
      blocked.conversation.id,
      { idempotencyKey: 'after-purge', body: 'What is in the photo?' },
    );
    const current: ModelInput['messages'] = [];
    const denied = new TaskWorker(blocked.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      objects: blocked.objects,
      createAdapter: () => ({
        generate: async (input) => {
          current.push(...input.messages);
          return {
            events: [
              { type: 'text', text: 'No live photo remains.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await denied.runOnce()).toBe(true);
    expect(current.some((message) => Boolean(message.images?.length))).toBe(false);
    expect(
      (
        await blockedTasks.get(
          blocked.owner.user.id,
          blocked.owner.workspace.id,
          blocked.conversation.id,
          blockedTask.id,
        )
      ).runs[0],
    ).toMatchObject({ status: 'completed' });
    const vision = await fixture(true);
    const messageId = await uploadImage(vision, 'purged-knowledge');
    expect(
      (
        await vision.app.inject({
          method: 'POST',
          url: `${vision.base}/messages/${messageId}/knowledge/promotions`,
          headers: vision.headers,
          payload: {
            destination: { kind: 'bot', id: vision.bot.id },
            idempotencyKey: 'image-purged',
            acknowledged: true,
            title: 'Cobalt photo',
            description: 'Keep the cobalt key',
          },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await vision.app.inject({
          method: 'POST',
          url: `${vision.base}/messages/${messageId}/purge`,
          headers: vision.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await vision.app.inject({
          method: 'POST',
          url: `${vision.base}/messages`,
          headers: vision.headers,
          payload: {
            idempotencyKey: 'after-purged-photo',
            body: 'Later I will ask about the stored photo.',
          },
        })
      ).statusCode,
    ).toBe(200);
    await new TaskService(vision.pool).submit(
      vision.owner.user.id,
      vision.owner.workspace.id,
      vision.conversation.id,
      { idempotencyKey: 'cite-purged-photo', body: 'What is the cobalt photo?' },
    );
    const later: ModelInput['messages'] = [];
    const laterWorker = new TaskWorker(vision.pool, {
      secrets: new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64')),
      objects: vision.objects,
      createAdapter: () => ({
        generate: async (input) => {
          later.push(...input.messages);
          return {
            events: [
              { type: 'text', text: 'The purged photo is gone.' },
              { type: 'complete', stopReason: 'stop' },
            ],
            raw: '',
          };
        },
      }),
    });
    expect(await laterWorker.runOnce()).toBe(true);
    expect(later.some((message) => message.content.includes('"kind":"scoped_knowledge"'))).toBe(
      false,
    );
    expect(later.some((message) => Boolean(message.images?.length))).toBe(false);
  });
});
