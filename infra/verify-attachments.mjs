import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { PostgresAuthRepository } from './dist/auth/postgres-auth-repository.js';
import { GroupService } from './dist/groups/service.js';
import { PostgresGroupRepository } from './dist/groups/postgres-group-repository.js';
import { ConversationService } from './dist/conversations/service.js';
import { PostgresConversationRepository } from './dist/conversations/postgres-repository.js';
const pool = new pg.Pool();
let stage = 'seed';
try {
  const actorUserId = randomUUID(),
    workspaceId = randomUUID(),
    token = randomBytes(32).toString('base64url'),
    now = new Date();
  await pool.query(
    'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,$4)',
    [actorUserId, `${actorUserId}@example.com`, 'Attachment smoke', now],
  );
  await pool.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,$3)', [
    workspaceId,
    'Attachment smoke',
    now,
  ]);
  await pool.query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,'owner',$3)",
    [workspaceId, actorUserId, now],
  );
  await new PostgresAuthRepository(pool).createSession({
    userId: actorUserId,
    tokenDigest: createHash('sha256').update(token).digest('hex'),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 180000),
    auditId: randomUUID(),
  });
  const group = await new GroupService(new PostgresGroupRepository(pool)).create(
    actorUserId,
    workspaceId,
    { name: 'Files' },
  );
  const conversation = await new ConversationService(new PostgresConversationRepository(pool)).open(
    actorUserId,
    workspaceId,
    { subject: { kind: 'group', id: group.id } },
  );
  const base = `http://127.0.0.1:3001/api/v1/workspaces/${workspaceId}/conversations/${conversation.id}`,
    headers = { origin: process.env.WEB_ORIGIN, cookie: `openbot_session=${token}` };
  const bytes = Buffer.alloc(3 * 1024 * 1024, 65),
    metadata = Buffer.from(
      JSON.stringify({
        body: 'Compose private attachment',
        filename: 'compose.txt',
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        idempotencyKey: 'compose-file',
      }),
    ),
    size = Buffer.alloc(4);
  size.writeUInt32BE(metadata.length);
  const request = (path, options = {}) =>
    fetch(base + path, {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: AbortSignal.timeout(10000),
    });
  stage = 'upload and replay';
  const publish = () =>
    request('/attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.concat([size, metadata, bytes]),
    });
  const first = await publish();
  assert.equal(first.status, 200);
  const receipt = (await first.json()).receipt;
  const replay = await publish();
  assert.equal(replay.status, 200);
  assert.deepEqual((await replay.json()).receipt, receipt);
  stage = 'download';
  const path = `/messages/${receipt.messageId}`;
  const download = await request(path + '/attachment/content');
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  stage = 'purge through running API cleanup';
  const purge = () =>
    request(path + '/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  assert.equal((await purge()).status, 202);
  assert.equal((await request(path + '/attachment/content')).status, 403);
  let complete = false;
  for (let attempt = 0; attempt < 360; attempt++) {
    const response = await purge();
    if (response.status === 200) {
      assert.deepEqual(await response.json(), { purge: { state: 'complete' } });
      complete = true;
      break;
    }
    assert.equal(response.status, 202);
    await setTimeout(250);
  }
  assert.ok(complete, 'attachment cleanup completion');
  assert.equal((await publish()).status, 409);
  assert.deepEqual(
    (
      await pool.query('SELECT filename,sha256 FROM attachment_objects WHERE conversation_id=$1', [
        conversation.id,
      ])
    ).rows,
    [{ filename: null, sha256: null }],
  );
  assert.ok(
    (
      await pool.query('SELECT body,reason FROM conversation_events WHERE conversation_id=$1', [
        conversation.id,
      ])
    ).rows.every((row) => row.body === null && row.reason === null),
  );
  console.log('Attachment Compose publication, private download and durable purge passed');
} catch {
  console.error(`Attachment Compose verification failed: ${stage}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
