import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAuthRepository } from './dist/auth/postgres-auth-repository.js';
import { GroupService } from './dist/groups/service.js';
import { PostgresGroupRepository } from './dist/groups/postgres-group-repository.js';
import { ConversationService } from './dist/conversations/service.js';
import { PostgresConversationRepository } from './dist/conversations/postgres-repository.js';
import { BOT_PRIVATE_VISIBILITY_SUMMARY } from './dist/memories/types.js';
const pool = new pg.Pool();
let stage = 'seed';
try {
  const workspaceId = randomUUID(),
    owner = randomUUID(),
    member = randomUUID(),
    outsider = randomUUID(),
    promotionOutsider = randomUUID();
  for (const userId of [owner, member, outsider, promotionOutsider])
    await pool.query(
      'INSERT INTO users(id,email,normalized_email,display_name,created_at) VALUES($1,$2,$2,$3,NOW())',
      [userId, `${userId}@example.com`, 'Memory smoke'],
    );
  await pool.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,NOW())', [
    workspaceId,
    'Memory smoke',
  ]);
  for (const userId of [owner, member, outsider, promotionOutsider])
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
    ownerToken = await session(owner),
    outsiderToken = await session(outsider),
    promotionOutsiderToken = await session(promotionOutsider),
    api = 'http://127.0.0.1:3001',
    base = `${api}/api/v1/workspaces/${workspaceId}/groups/${group.id}/memories`;
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
  const workspaceRequest = (path, body, using = ownerToken) =>
    fetch(`${api}${path}`, {
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
  stage = 'promotion destination Bots';
  const promoteSource = await conversations.append(owner, workspaceId, conversation.id, {
    body: 'Compose private promotion evidence',
    idempotencyKey: 'promote-source',
  });
  const promoteSaved = await request('', {
    messageId: promoteSource.messageId,
    expectedSourceEventId: promoteSource.eventId,
    confidence: 0.5,
    idempotencyKey: 'promote-save',
  });
  assert.equal(promoteSaved.status, 201);
  const promoteMemory = (await promoteSaved.json()).memory;
  async function insertOwnedBot(name) {
    const connection = await pool.connect(),
      id = randomUUID(),
      versionId = randomUUID();
    try {
      await connection.query('BEGIN');
      await connection.query(
        "INSERT INTO bots(id,workspace_id,current_version_id,visibility,created_by_user_id,created_at) VALUES($1,$2,$3,'private',$4,NOW())",
        [id, workspaceId, versionId, owner],
      );
      await connection.query(
        "INSERT INTO bot_versions(id,bot_id,version,configuration,author_user_id,created_at,rationale) VALUES($1,$2,1,$3::jsonb,$4,NOW(),'Created')",
        [
          versionId,
          id,
          JSON.stringify({
            name,
            roleDescription: 'Researcher',
            description: '',
            instructions: 'Use promoted evidence.',
            modelBinding: {
              scope: { kind: 'workspace', id: workspaceId },
              connectionId: randomUUID(),
              modelId: 'compose-promotion-model',
            },
            limits: {
              maxTotalTokens: 32768,
              maxDurationSeconds: 300,
              maxTurns: 8,
              maxDelegationDepth: 2,
            },
          }),
          owner,
        ],
      );
      await connection.query(
        "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'owner',NOW())",
        [id, owner],
      );
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
    return { id, name };
  }
  const dest = await insertOwnedBot('Compose private destination');
  const otherBot = await insertOwnedBot('Compose isolated Bot');
  stage = 'promotion preview and confirm';
  assert.equal(
    (
      await request(
        '/' + promoteMemory.id + '/promotion-previews',
        { destinationBotId: dest.id },
        token,
      )
    ).status,
    403,
  );
  // Preview denials write memory.access_denied. Keep that actor distinct from
  // the search-denial subject the Compose observer reads by actorUserId.
  assert.equal(
    (
      await request(
        '/' + promoteMemory.id + '/promotion-previews',
        { destinationBotId: dest.id },
        promotionOutsiderToken,
      )
    ).status,
    403,
  );
  const preview = await request(
    '/' + promoteMemory.id + '/promotion-previews',
    { destinationBotId: dest.id },
    ownerToken,
  );
  assert.equal(preview.status, 200);
  const previewBody = (await preview.json()).preview;
  assert.equal(previewBody.source.groupId, group.id);
  assert.equal(previewBody.source.memoryId, promoteMemory.id);
  assert.equal(previewBody.source.text, promoteMemory.text);
  assert.equal(previewBody.destinationBot.id, dest.id);
  assert.equal(previewBody.destinationBot.name, 'Compose private destination');
  assert.equal(previewBody.visibility.kind, 'bot-private');
  assert.equal(previewBody.visibility.botId, dest.id);
  assert.equal(previewBody.visibility.summary, BOT_PRIVATE_VISIBILITY_SUMMARY);
  assert.equal(previewBody.content, promoteMemory.text);
  assert.equal(
    (await pool.query('SELECT id FROM bot_private_memories WHERE workspace_id=$1', [workspaceId]))
      .rows.length,
    0,
  );
  assert.equal(
    (
      await request(
        '/' + promoteMemory.id + '/promotions',
        { intentId: previewBody.id, idempotencyKey: 'compose-promote', acknowledged: false },
        ownerToken,
      )
    ).status,
    400,
  );
  const confirmed = await request(
    '/' + promoteMemory.id + '/promotions',
    { intentId: previewBody.id, idempotencyKey: 'compose-promote', acknowledged: true },
    ownerToken,
  );
  assert.equal(confirmed.status, 201);
  const promoted = (await confirmed.json()).memory;
  assert.equal(promoted.version, 1);
  assert.equal(promoted.scope.kind, 'bot-private');
  assert.equal(promoted.scope.botId, dest.id);
  assert.equal(promoted.sourceGroupId, group.id);
  assert.equal(promoted.sourceMemoryId, promoteMemory.id);
  assert.equal(promoted.approver.id, owner);
  assert.equal(promoted.text, promoteMemory.text);
  assert.ok(Date.parse(promoted.approvedAt) > 0);
  const listed = await workspaceRequest(
    `/api/v1/workspaces/${workspaceId}/bots/${dest.id}/private-memories`,
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(
    (await listed.json()).memories.map((item) => item.id),
    [promoted.id],
  );
  const otherListed = await workspaceRequest(
    `/api/v1/workspaces/${workspaceId}/bots/${otherBot.id}/private-memories`,
  );
  assert.equal(otherListed.status, 200);
  assert.deepEqual((await otherListed.json()).memories, []);
  const otherSearch = await workspaceRequest(
    `/api/v1/workspaces/${workspaceId}/bots/${otherBot.id}/private-memories/search`,
    { query: 'promotion' },
  );
  assert.equal(otherSearch.status, 200);
  assert.deepEqual((await otherSearch.json()).memories, []);
  await groups.create(owner, workspaceId, { name: 'Second compose group' });
  const destSearch = await workspaceRequest(
    `/api/v1/workspaces/${workspaceId}/bots/${dest.id}/private-memories/search`,
    { query: 'PROMOTION' },
  );
  assert.equal(destSearch.status, 200);
  assert.deepEqual(
    (await destSearch.json()).memories.map((item) => item.id),
    [promoted.id],
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
  assert.equal(rows.length, 2);
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
    'run_source_manifests',
    'run_source_manifest_items',
    'memory_candidates',
    'memory_candidate_revisions',
    'memory_candidate_sources',
    'memory_extraction_jobs',
    'approved_memory_facts',
    'memory_candidate_decisions',
    'memory_candidate_review_intents',
    'memory_candidate_review_confirmations',
    'run_approved_fact_references',
    'knowledge_documents',
    'knowledge_chunks',
    'run_knowledge_references',
    'memory_revisions',
    'memory_revocation_events',
  ]) {
    const privileges = (
      await pool.query(
        "SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS append,has_table_privilege(current_user,$1,'UPDATE') AS mutate,has_table_privilege(current_user,$1,'DELETE') AS remove,has_table_privilege(current_user,$1,'TRUNCATE') AS truncate",
        [table],
      )
    ).rows[0];
    assert.deepEqual(
      privileges,
      {
        read: true,
        append: true,
        mutate: false,
        remove: false,
        truncate: false,
      },
      table,
    );
  }
  assert.deepEqual(
    (
      await pool.query(
        "SELECT column_name,has_column_privilege(current_user,'memory_extraction_jobs',column_name,'UPDATE') AS allowed FROM information_schema.columns WHERE table_schema='public' AND table_name='memory_extraction_jobs' ORDER BY column_name",
      )
    ).rows,
    [
      { column_name: 'attempt_count', allowed: true },
      { column_name: 'available_at', allowed: true },
      { column_name: 'claim_token', allowed: true },
      { column_name: 'created_at', allowed: false },
      { column_name: 'extractor_version', allowed: false },
      { column_name: 'last_error_code', allowed: true },
      { column_name: 'lease_expires_at', allowed: true },
      { column_name: 'manifest_digest', allowed: false },
      { column_name: 'normalizer_version', allowed: false },
      { column_name: 'output_event_id', allowed: false },
      { column_name: 'run_id', allowed: false },
      { column_name: 'status', allowed: true },
      { column_name: 'updated_at', allowed: true },
    ],
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT column_name,has_column_privilege(current_user,'memory_candidates',column_name,'UPDATE') AS allowed FROM information_schema.columns WHERE table_schema='public' AND table_name='memory_candidates' ORDER BY column_name",
      )
    ).rows,
    [
      { column_name: 'confidence', allowed: false },
      { column_name: 'confidence_source', allowed: false },
      { column_name: 'created_at', allowed: false },
      { column_name: 'current_revision', allowed: true },
      { column_name: 'extractor_version', allowed: false },
      { column_name: 'id', allowed: false },
      { column_name: 'manifest_digest', allowed: false },
      { column_name: 'normalized_fingerprint', allowed: false },
      { column_name: 'origin_bot_version_id', allowed: false },
      { column_name: 'origin_task_id', allowed: false },
      { column_name: 'output_event_id', allowed: false },
      { column_name: 'proposed_scope_id', allowed: false },
      { column_name: 'proposed_scope_kind', allowed: false },
      { column_name: 'run_id', allowed: false },
      { column_name: 'status', allowed: true },
      { column_name: 'workspace_id', allowed: false },
    ],
  );
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
} catch (error) {
  console.error(`Memory Compose verification failed: ${stage}`);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
