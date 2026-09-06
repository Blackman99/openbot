import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { MemoryInputError, memoryObject, memoryUuid } from './types.js';

export type MemoryRevocationReason = 'source_deleted' | 'source_purged' | 'source_tombstoned';
export type MemoryRevocationTarget = 'group_memory' | 'private_memory' | 'approved_fact';

export function memoryEditInput(input: unknown): { expectedVersionId: string; body: string } {
  const value = memoryObject(input, ['expectedVersionId', 'body']);
  if (typeof value.body !== 'string') throw new MemoryInputError();
  const body = value.body.normalize('NFC').replace(/\r\n/gu, '\n').trim();
  if (!body || [...body].length > 1000 || Buffer.byteLength(body) > 4096)
    throw new MemoryInputError();
  return { expectedVersionId: memoryUuid(value.expectedVersionId), body };
}

export function memoryForgetInput(input: unknown): { expectedVersionId: string } {
  const value = memoryObject(input, ['expectedVersionId']);
  return { expectedVersionId: memoryUuid(value.expectedVersionId) };
}

export function memoryRevocationInput(input: unknown): {
  expectedVersionId: string;
  idempotencyKey: string;
} {
  const value = memoryObject(input, ['expectedVersionId', 'idempotencyKey']);
  if (
    typeof value.idempotencyKey !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/u.test(value.idempotencyKey)
  )
    throw new MemoryInputError();
  return {
    expectedVersionId: memoryUuid(value.expectedVersionId),
    idempotencyKey: value.idempotencyKey,
  };
}

export async function enqueueSourceRevocations(
  connection: SqlConnection,
  input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    reason: MemoryRevocationReason;
    createdAt: Date;
  },
) {
  const targets = await listDerivedTargets(connection, input);
  for (const target of targets) {
    const existing = (
      await connection.query<{ id: string }>(
        'SELECT id FROM memory_revocation_events WHERE target_kind=$1 AND target_id=$2 LIMIT 1',
        [target.kind, target.id],
      )
    ).rows[0];
    if (existing) continue;
    await connection.query(
      `INSERT INTO memory_revocation_events(
        id,workspace_id,target_kind,target_id,target_version_id,action,reason,source_message_id,actor_user_id,retained_body,created_at
      ) VALUES($1,$2,$3,$4,$5,'pending',$6,$7,NULL,NULL,$8)`,
      [
        randomUUID(),
        input.workspaceId,
        target.kind,
        target.id,
        target.versionId,
        input.reason,
        input.messageId,
        input.createdAt,
      ],
    );
  }
}

async function listDerivedTargets(
  connection: SqlConnection,
  input: { workspaceId: string; conversationId: string; messageId: string },
): Promise<Array<{ kind: MemoryRevocationTarget; id: string; versionId: string }>> {
  const groups = await connection.query<{ id: string; version_id: string }>(
    `SELECT m.id, v.id AS version_id
     FROM group_memories m
     JOIN memory_versions v ON v.memory_id=m.id AND v.version=1
     LEFT JOIN memory_revisions tomb ON tomb.memory_id=m.id AND tomb.kind='tombstone'
     WHERE m.workspace_id=$1 AND m.conversation_id=$2 AND v.source_message_id=$3 AND tomb.id IS NULL`,
    [input.workspaceId, input.conversationId, input.messageId],
  );
  const privates = await connection.query<{ id: string; version_id: string }>(
    `SELECT p.id, p.version_id
     FROM bot_private_memories p
     JOIN memory_versions v ON v.id=p.source_memory_version_id AND v.memory_id=p.source_memory_id
     JOIN group_memories m ON m.id=p.source_memory_id
     WHERE p.workspace_id=$1 AND m.conversation_id=$2 AND v.source_message_id=$3`,
    [input.workspaceId, input.conversationId, input.messageId],
  );
  const facts = await connection.query<{ id: string; version_id: string }>(
    `SELECT f.id, f.version_id
     FROM approved_memory_facts f
     JOIN memory_candidates c ON c.id=f.candidate_id
     JOIN memory_candidate_sources s ON s.candidate_id=c.id
     JOIN conversation_events e ON e.id=s.event_id
     WHERE f.workspace_id=$1 AND e.conversation_id=$2 AND e.message_id=$3`,
    [input.workspaceId, input.conversationId, input.messageId],
  );
  const seen = new Set<string>();
  const rows: Array<{ kind: MemoryRevocationTarget; id: string; versionId: string }> = [];
  for (const [kind, list] of [
    ['group_memory', groups.rows],
    ['private_memory', privates.rows],
    ['approved_fact', facts.rows],
  ] as const) {
    for (const row of list) {
      const key = `${kind}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ kind, id: row.id, versionId: row.version_id });
    }
  }
  return rows;
}
