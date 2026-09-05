import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { lockAuthorizedBot } from '../bots/postgres-bot-access.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import {
  BOT_FACT_VISIBILITY_SUMMARY,
  GROUP_FACT_VISIBILITY_SUMMARY,
  REVIEW_DISCLOSURE_VERSION,
  WORKSPACE_FACT_VISIBILITY_SUMMARY,
} from './review-schema.js';
import {
  MemoryAccessError,
  MemoryConflictError,
  type ApprovedFact,
  type CandidateAccess,
  type CandidateDestination,
  type MemoryCandidate,
} from './types.js';

const PREVIEW_TTL_MS = 5 * 60 * 1000;

export type CandidateRow = {
  id: string;
  run_id: string;
  workspace_id: string;
  status: 'pending' | 'approved' | 'rejected';
  current_revision: number;
  proposed_scope_kind: CandidateDestination['kind'];
  proposed_scope_id: string;
  confidence: number;
  output_event_id: string;
  origin_task_id: string;
  origin_bot_id: string;
  origin_bot_version_id: string;
  conversation_id: string;
  group_id: string | null;
  created_at: Date;
  body: string;
  source_count: string | number;
};

export type ApprovedFactRow = {
  id: string;
  version_id: string;
  workspace_id: string;
  scope_kind: CandidateDestination['kind'];
  scope_id: string;
  candidate_id: string;
  body: string;
  confidence: number;
  approver_user_id: string;
  approver_name: string;
  approved_at: Date;
};

export function projectCandidate(row: CandidateRow): MemoryCandidate {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    revision: Number(row.current_revision),
    body: row.body,
    proposedScope: { kind: row.proposed_scope_kind, id: row.proposed_scope_id },
    confidence: row.confidence,
    confidenceSource: 'local_rule',
    sourceCount: Number(row.source_count),
    createdAt: row.created_at,
  };
}

export function projectApprovedFact(row: ApprovedFactRow): ApprovedFact {
  return {
    kind: 'approved_fact',
    id: row.id,
    versionId: row.version_id,
    version: 1,
    candidateId: row.candidate_id,
    scope: {
      kind: row.scope_kind,
      workspaceId: row.workspace_id,
      id: row.scope_id,
    },
    creator: { id: row.approver_user_id, displayName: row.approver_name },
    createdAt: row.approved_at,
    confidence: row.confidence,
    confidenceSource: 'human',
    text: row.body,
  };
}

export function candidateLineageDigest(row: CandidateRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        candidateId: row.id,
        runId: row.run_id,
        revision: Number(row.current_revision),
        outputEventId: row.output_event_id,
      }),
    )
    .digest('hex');
}

export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function reviewCommandHash(input: {
  type: 'memory.candidate.reject' | 'memory.candidate.approve';
  candidateId: string;
  revision: number;
  bodyHash: string;
  destination?: CandidateDestination;
  confidence?: number;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function requiresSeparateConfirmation(
  originGroupId: string | null,
  destination: CandidateDestination,
): boolean {
  return !(
    destination.kind === 'group' &&
    originGroupId !== null &&
    destination.id === originGroupId
  );
}

export function destinationAudience(destination: CandidateDestination): {
  kind: CandidateDestination['kind'];
  id: string;
  summary: string;
} {
  return {
    kind: destination.kind,
    id: destination.id,
    summary:
      destination.kind === 'group'
        ? GROUP_FACT_VISIBILITY_SUMMARY
        : destination.kind === 'bot'
          ? BOT_FACT_VISIBILITY_SUMMARY
          : WORKSPACE_FACT_VISIBILITY_SUMMARY,
  };
}

export async function lockWorkspaceMember(
  connection: SqlConnection,
  access: CandidateAccess,
): Promise<{ role: string }> {
  await connection.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [access.workspaceId]);
  const member = (
    await connection.query<{ role: string }>(
      'SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
      [access.workspaceId, access.actorUserId],
    )
  ).rows[0];
  if (!member) throw new MemoryAccessError();
  return member;
}

export async function lockReviewScopes(
  connection: SqlConnection,
  access: CandidateAccess,
  origin: { groupId: string | null; botId: string },
  destination: CandidateDestination | undefined,
  now: () => Date,
) {
  const groups = [
    ...new Set(
      [origin.groupId, destination?.kind === 'group' ? destination.id : null].filter(
        (id): id is string => id != null,
      ),
    ),
  ].sort();
  for (const groupId of groups)
    await lockAuthorizedGroup(
      connection,
      { actorId: access.actorUserId, workspaceId: access.workspaceId, groupId },
      'content',
    );
  const bots = [
    ...new Set(
      [origin.botId, destination?.kind === 'bot' ? destination.id : null].filter(
        (id): id is string => id != null,
      ),
    ),
  ].sort();
  let destinationBot: Awaited<ReturnType<typeof lockAuthorizedBot>> | undefined;
  for (const botId of bots) {
    if (destination?.kind === 'bot' && destination.id === botId) {
      destinationBot = await lockAuthorizedBot(
        connection,
        { actorUserId: access.actorUserId, workspaceId: access.workspaceId, botId },
        'edit',
      );
      if (destinationBot.lifecycle_state === 'deleted') throw new MemoryAccessError();
    } else {
      const locked = (
        await connection.query<{ id: string }>(
          'SELECT id FROM bots WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [access.workspaceId, botId],
        )
      ).rows[0];
      if (!locked) throw new MemoryAccessError();
    }
  }
  if (destination?.kind === 'workspace') {
    if (destination.id !== access.workspaceId) throw new MemoryAccessError();
    const role = (
      await connection.query<{ role: string }>(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','administrator')",
        [access.workspaceId, access.actorUserId],
      )
    ).rows[0];
    if (!role) throw new MemoryAccessError();
  }
  await ConversationTransaction.lock(
    connection,
    {
      actorUserId: access.actorUserId,
      workspaceId: access.workspaceId,
      conversationId: access.conversationId,
    },
    now,
    'inspect',
  );
  return destinationBot;
}

export async function loadCandidate(
  connection: SqlConnection,
  access: CandidateAccess,
  candidateId: string,
): Promise<CandidateRow> {
  const row = (
    await connection.query<CandidateRow>(
      `SELECT c.id,c.run_id,c.workspace_id,c.status,c.current_revision,c.proposed_scope_kind,c.proposed_scope_id,c.confidence,c.output_event_id,c.origin_task_id,c.origin_bot_version_id,c.created_at,
              t.bot_id AS origin_bot_id,t.conversation_id,conv.group_id,r.body,src.source_count
       FROM memory_candidates c
       JOIN tasks t ON t.id=c.origin_task_id
       JOIN conversations conv ON conv.id=t.conversation_id
       JOIN memory_candidate_revisions r ON r.candidate_id=c.id AND r.revision=c.current_revision
       JOIN (SELECT candidate_id,COUNT(*) AS source_count FROM memory_candidate_sources GROUP BY candidate_id) src ON src.candidate_id=c.id
       WHERE c.id=$1 AND c.workspace_id=$2 AND t.conversation_id=$3`,
      [candidateId, access.workspaceId, access.conversationId],
    )
  ).rows[0];
  if (!row) throw new MemoryAccessError();
  return row;
}

export async function lockCandidateRow(
  connection: SqlConnection,
  row: CandidateRow,
): Promise<void> {
  await connection.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [row.origin_task_id]);
  await connection.query('SELECT id FROM task_runs WHERE id=$1 FOR UPDATE', [row.run_id]);
  const locked = (
    await connection.query<{ id: string }>(
      'SELECT id FROM memory_candidates WHERE id=$1 FOR UPDATE',
      [row.id],
    )
  ).rows[0];
  if (!locked) throw new MemoryAccessError();
}

export async function lockPendingCandidate(
  connection: SqlConnection,
  access: CandidateAccess,
  row: CandidateRow,
  expectedRevision: number,
): Promise<CandidateRow> {
  await lockCandidateRow(connection, row);
  const locked = await loadCandidate(connection, access, row.id);
  if (locked.status !== 'pending' || Number(locked.current_revision) !== expectedRevision)
    throw new MemoryConflictError('source_version_conflict');
  return locked;
}

export async function selectApprovedFactRows(
  connection: SqlConnection,
  filter: {
    workspaceId: string;
    groupId?: string;
    botId?: string;
    includeWorkspace?: boolean;
    query?: string;
    after?: string;
    limit: number;
  },
): Promise<ApprovedFactRow[]> {
  const parameters: unknown[] = [filter.workspaceId, filter.limit];
  const scopes: string[] = [];
  if (filter.groupId !== undefined) {
    parameters.push(filter.groupId);
    scopes.push(`(f.scope_kind='group' AND f.scope_id=$${parameters.length})`);
  }
  if (filter.botId !== undefined) {
    parameters.push(filter.botId);
    scopes.push(`(f.scope_kind='bot' AND f.scope_id=$${parameters.length})`);
  }
  if (filter.includeWorkspace) scopes.push(`(f.scope_kind='workspace' AND f.scope_id=$1)`);
  if (!scopes.length) return [];
  let extra = '';
  if (filter.after) {
    parameters.push(filter.after);
    extra += ` AND f.id>$${parameters.length}`;
  }
  if (filter.query !== undefined && filter.query !== '') {
    parameters.push(`%${filter.query.replace(/[\\%_]/gu, '\\$&')}%`);
    extra += ` AND f.body ILIKE $${parameters.length}`;
  }
  return (
    await connection.query<ApprovedFactRow>(
      `SELECT f.id,f.version_id,f.workspace_id,f.scope_kind,f.scope_id,f.candidate_id,f.body,f.confidence,f.approver_user_id,u.display_name AS approver_name,f.approved_at
       FROM approved_memory_facts f
       JOIN memory_candidates c ON c.id=f.candidate_id
       JOIN users u ON u.id=f.approver_user_id
       JOIN conversation_events e ON e.id=c.output_event_id
       LEFT JOIN conversation_events later_out ON later_out.conversation_id=e.conversation_id AND later_out.message_id=e.message_id AND later_out.sequence>e.sequence
       LEFT JOIN message_purges p ON p.workspace_id=f.workspace_id AND p.message_id=e.message_id
       LEFT JOIN memory_revocation_events fact_revoc ON fact_revoc.target_kind='approved_fact' AND fact_revoc.target_id=f.id
       LEFT JOIN memory_revocation_events later_fact ON later_fact.target_kind='approved_fact' AND later_fact.target_id=f.id AND later_fact.created_at > fact_revoc.created_at
       LEFT JOIN memory_revocation_events fact_revoked ON fact_revoked.target_kind='approved_fact' AND fact_revoked.target_id=f.id AND fact_revoked.action='revoke'
       LEFT JOIN (
         SELECT DISTINCT s.candidate_id
         FROM memory_candidate_sources s
         JOIN conversation_events src ON src.id=s.event_id
         LEFT JOIN conversation_events later_src ON later_src.conversation_id=src.conversation_id AND later_src.message_id=src.message_id AND later_src.sequence>src.sequence
         LEFT JOIN memory_candidate_sources later_known ON later_known.candidate_id=s.candidate_id AND later_known.event_id=later_src.id
         LEFT JOIN message_purges src_purge ON src_purge.workspace_id=$1 AND src_purge.message_id=src.message_id
         WHERE src.body IS NULL OR src_purge.message_id IS NOT NULL OR (later_src.id IS NOT NULL AND later_known.event_id IS NULL)
       ) stale ON stale.candidate_id=c.id
       WHERE f.workspace_id=$1 AND (${scopes.join(' OR ')})
         AND later_fact.id IS NULL AND fact_revoked.id IS NULL AND (fact_revoc.id IS NULL OR fact_revoc.action='retain')
         AND (
           fact_revoc.action='retain'
           OR (
             e.body IS NOT NULL AND p.message_id IS NULL AND later_out.id IS NULL AND stale.candidate_id IS NULL
           )
         )${extra}
       ORDER BY f.id LIMIT $2`,
      parameters,
    )
  ).rows;
}

export async function replayDecision(
  connection: SqlConnection,
  access: CandidateAccess,
  idempotencyKey: string,
  hash: string,
): Promise<{ replayed: true; candidate: MemoryCandidate; fact?: ApprovedFact } | undefined> {
  const prior = (
    await connection.query<{
      candidate_id: string;
      command_hash: string;
      approved_fact_id: string | null;
    }>(
      'SELECT candidate_id,command_hash,approved_fact_id FROM memory_candidate_decisions WHERE workspace_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',
      [access.workspaceId, access.actorUserId, idempotencyKey],
    )
  ).rows[0];
  if (!prior) return;
  if (prior.command_hash !== hash) throw new MemoryConflictError('idempotency_conflict');
  const candidate = projectCandidate(await loadCandidate(connection, access, prior.candidate_id));
  if (!prior.approved_fact_id) return { replayed: true, candidate };
  const fact = (
    await connection.query<ApprovedFactRow>(
      `SELECT f.id,f.version_id,f.workspace_id,f.scope_kind,f.scope_id,f.candidate_id,f.body,f.confidence,f.approver_user_id,u.display_name AS approver_name,f.approved_at
       FROM approved_memory_facts f JOIN users u ON u.id=f.approver_user_id WHERE f.id=$1`,
      [prior.approved_fact_id],
    )
  ).rows[0];
  if (!fact) throw new MemoryAccessError();
  return { replayed: true, candidate, fact: projectApprovedFact(fact) };
}

export async function insertDecision(
  connection: SqlConnection,
  input: {
    access: CandidateAccess;
    row: CandidateRow;
    decision: 'approved' | 'rejected';
    destination?: CandidateDestination;
    factId?: string;
    confidence?: number;
    idempotencyKey: string;
    now: Date;
  },
): Promise<void> {
  const hash = reviewCommandHash({
    type: input.decision === 'rejected' ? 'memory.candidate.reject' : 'memory.candidate.approve',
    candidateId: input.row.id,
    revision: Number(input.row.current_revision),
    bodyHash: textHash(input.row.body),
    ...(input.destination ? { destination: input.destination } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
  });
  await connection.query(
    `INSERT INTO memory_candidate_decisions(
      candidate_id,workspace_id,actor_user_id,decision,expected_revision,reviewed_body_hash,destination_scope_kind,destination_scope_id,approved_fact_id,idempotency_key,command_hash,decided_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      input.row.id,
      input.access.workspaceId,
      input.access.actorUserId,
      input.decision,
      Number(input.row.current_revision),
      textHash(input.row.body),
      input.destination?.kind ?? null,
      input.destination?.id ?? null,
      input.factId ?? null,
      input.idempotencyKey,
      hash,
      input.now,
    ],
  );
  await connection.query(
    'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
    [
      randomUUID(),
      input.decision === 'rejected' ? 'memory.candidate.rejected' : 'memory.candidate.approved',
      input.access.actorUserId,
      input.now,
      JSON.stringify({
        workspaceId: input.access.workspaceId,
        conversationId: input.access.conversationId,
        candidateId: input.row.id,
        revision: Number(input.row.current_revision),
        ...(input.destination
          ? { destinationKind: input.destination.kind, destinationId: input.destination.id }
          : {}),
        ...(input.factId ? { factId: input.factId } : {}),
      }),
    ],
  );
}

export async function publishApprovedFact(
  connection: SqlConnection,
  input: {
    access: CandidateAccess;
    row: CandidateRow;
    destination: CandidateDestination;
    confidence: number;
    now: Date;
  },
): Promise<ApprovedFact> {
  const factId = randomUUID(),
    versionId = randomUUID();
  const updated = await connection.query(
    "UPDATE memory_candidates SET status='approved' WHERE id=$1 AND status='pending' AND current_revision=$2 RETURNING id",
    [input.row.id, Number(input.row.current_revision)],
  );
  if (!updated.rows.length) throw new MemoryConflictError('source_version_conflict');
  await connection.query(
    `INSERT INTO approved_memory_facts(
      id,workspace_id,scope_kind,scope_id,candidate_id,revision,body,confidence,confidence_source,approver_user_id,approved_at,version,version_id,lineage_digest
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'human',$9,$10,1,$11,$12)`,
    [
      factId,
      input.access.workspaceId,
      input.destination.kind,
      input.destination.id,
      input.row.id,
      Number(input.row.current_revision),
      input.row.body,
      input.confidence,
      input.access.actorUserId,
      input.now,
      versionId,
      candidateLineageDigest(input.row),
    ],
  );
  return projectApprovedFact({
    id: factId,
    version_id: versionId,
    workspace_id: input.access.workspaceId,
    scope_kind: input.destination.kind,
    scope_id: input.destination.id,
    candidate_id: input.row.id,
    body: input.row.body,
    confidence: input.confidence,
    approver_user_id: input.access.actorUserId,
    approver_name: (
      await connection.query<{ display_name: string }>(
        'SELECT display_name FROM users WHERE id=$1',
        [input.access.actorUserId],
      )
    ).rows[0]!.display_name,
    approved_at: input.now,
  });
}

export { PREVIEW_TTL_MS, REVIEW_DISCLOSURE_VERSION };
