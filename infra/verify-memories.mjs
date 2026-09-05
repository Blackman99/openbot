import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAuthRepository } from './dist/auth/postgres-auth-repository.js';
import { GroupService } from './dist/groups/service.js';
import { PostgresGroupRepository } from './dist/groups/postgres-group-repository.js';
import { ConversationService } from './dist/conversations/service.js';
import { PostgresConversationRepository } from './dist/conversations/postgres-repository.js';
const pool = new pg.Pool();
let stage = 'seed';
try {
  const workspaceId = randomUUID(),
    owner = randomUUID(),
    member = randomUUID(),
    outsider = randomUUID();
  for (const userId of [owner, member, outsider])
    await pool.query(
      'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
      [userId, `${userId}@example.com`, 'Memory smoke'],
    );
  await pool.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
    workspaceId,
    'Memory smoke',
  ]);
  for (const userId of [owner, member, outsider])
    await pool.query(
      'INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,NOW())',
      [workspaceId, userId, userId === owner ? 'owner' : 'member'],
    );
  const groups = new GroupService(new PostgresGroupRepository(pool)),
    group = await groups.create(owner, workspaceId, { name: 'Source memories' });
  await groups.addMember(owner, workspaceId, group.id, { userId: member, role: 'member' });
  const conversations = new ConversationService(new PostgresConversationRepository(pool));
  const conversation = await conversations.open(owner, workspaceId, {
    subject: { kind: 'group', id: group.id },
  });
  const source = await conversations.append(owner, workspaceId, conversation.id, {
    body: 'Compose cobalt memory evidence',
    idempotencyKey: 'source',
  });
  async function session(userId) {
    const token = randomBytes(32).toString('base64url'),
      now = new Date();
    await new PostgresAuthRepository(pool).createSession({
      userId,
      tokenDigest: createHash('sha256').update(token).digest('hex'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 180000),
      auditId: randomUUID(),
    });
    return token;
  }
  const token = await session(member),
    outsiderToken = await session(outsider),
    base = `http://127.0.0.1:3001/api/v1/workspaces/${workspaceId}/groups/${group.id}/memories`;
  const request = (path = '', body, using = token) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        cookie: `openbot_session=${using}`,
        origin: process.env.WEB_ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
  stage = 'save and replay';
  const command = {
    messageId: source.messageId,
    expectedSourceEventId: source.eventId,
    confidence: 0.5,
    idempotencyKey: 'save',
  };
  const created = await request('', command);
  assert.equal(created.status, 201);
  const memory = (await created.json()).memory;
  assert.equal(memory.creator.id, member);
  assert.equal(memory.version, 1);
  assert.equal(memory.source.eventId, source.eventId);
  assert.equal(memory.confidenceSource, 'human');
  const replay = await request('', command);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).memory.id, memory.id);
  const read = await request('/' + memory.id);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('cache-control'), 'private, no-store');
  const search = await request('/search', { query: 'COBALT' });
  assert.equal(search.status, 200);
  assert.deepEqual(
    (await search.json()).memories.map((item) => item.id),
    [memory.id],
  );
  stage = 'scope denial';
  assert.equal(
    (await request('/search', { query: 'do-not-audit-this-body' }, outsiderToken)).status,
    403,
  );
  stage = 'current source revocation';
  await conversations.edit(owner, workspaceId, conversation.id, source.messageId, {
    body: 'Current source changed',
    expectedVersion: 1,
    idempotencyKey: 'edit',
  });
  assert.equal((await request('/' + memory.id)).status, 403);
  assert.deepEqual((await (await request('/search', { query: 'COBALT' })).json()).memories, []);
  assert.equal((await request('', command)).status, 403);
  const rows = (
    await pool.query(
      'SELECT v.* FROM memory_versions v JOIN group_memories m ON m.id=v.memory_id WHERE m.group_id=$1',
      [group.id],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes('cobalt'), false);
  stage = 'retained table privileges';
  for (const table of [
    'group_memories',
    'memory_versions',
    'run_memory_references',
    'memory_promotion_intents',
    'bot_private_memories',
    'memory_promotion_confirmations',
    'run_private_memory_references',
  ]) {
    const privileges = (
      await pool.query(
        "SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS append,has_table_privilege(current_user,$1,'UPDATE') AS mutate,has_table_privilege(current_user,$1,'DELETE') AS remove,has_table_privilege(current_user,$1,'TRUNCATE') AS truncate",
        [table],
      )
    ).rows[0];
    assert.deepEqual(privileges, {
      read: true,
      append: true,
      mutate: false,
      remove: false,
      truncate: false,
    });
  }
  assert.deepEqual(
    (
      await pool.query(
        "SELECT current_user AS role,has_table_privilege(current_user,'audit_events','SELECT') AS read,has_table_privilege(current_user,'audit_events','INSERT') AS append",
      )
    ).rows,
    [{ role: 'openbot_runtime', read: false, append: true }],
  );
  // The CI observer checks this exact audit through the PostgreSQL container.
  // The API keeps its append-only audit privilege and never receives observer credentials.
  console.log(
    JSON.stringify({
      actorUserId: outsider,
      expectedAudits: [{ metadata: { operation: 'search', workspaceId, groupId: group.id } }],
    }),
  );
} catch {
  console.error(`Memory Compose verification failed: ${stage}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
