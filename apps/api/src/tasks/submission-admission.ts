import { createHash } from 'node:crypto';
import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { admitBotModel } from '../bots/model-binding.js';
import { ConversationTransaction } from '../conversations/postgres-repository.js';
import {
  ConversationAccessError,
  ConversationConflictError,
  type ConversationAccess,
} from '../conversations/service.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import { admitGroupLead } from '../routing/admission.js';
import type { RoutingDecision } from '../routing/matcher.js';
import { admitTaskTarget } from './admission.js';

export function taskSubmissionHash(body: string, grantId: string | null) {
  return createHash('sha256')
    .update(JSON.stringify({ type: 'task.submit', body, grantId }))
    .digest('hex');
}

// Retain the structural lock through the caller's trigger, Task, decision and audit
// writes. Replay admits the persisted grant/version; it must never reroute.
export async function admitTaskSubmission(
  connection: SqlConnection,
  access: ConversationAccess,
  command: { idempotencyKey: string; body: string; groupGrantId: string | null },
  now: () => Date,
) {
  const subject = (
    await connection.query<{ group_id: string | null }>(
      'SELECT group_id FROM conversations WHERE workspace_id=$1 AND id=$2',
      [access.workspaceId, access.conversationId],
    )
  ).rows[0];
  if (!subject) throw new ConversationAccessError();
  if (subject.group_id) {
    await lockAuthorizedGroup(
      connection,
      {
        actorId: access.actorUserId,
        workspaceId: access.workspaceId,
        groupId: subject.group_id,
      },
      'content',
    );
  } else {
    if (command.groupGrantId) throw new ConversationAccessError();
    await ConversationTransaction.lock(connection, access, now);
  }
  const prior = (
    await connection.query<{
      event_id: string;
      task_id: string | null;
      command_hash: string | null;
      group_grant_id: string | null;
      bot_version_id: string | null;
      request_hash: string | null;
    }>(
      `SELECT e.id AS event_id,t.id AS task_id,t.command_hash,t.group_grant_id,t.bot_version_id,d.request_hash
     FROM conversation_events e LEFT JOIN tasks t ON t.trigger_event_id=e.id
     LEFT JOIN task_routing_decisions d ON d.task_id=t.id
     WHERE e.conversation_id=$1 AND e.actor_user_id=$2 AND e.idempotency_key=$3`,
      [access.conversationId, access.actorUserId, command.idempotencyKey],
    )
  ).rows[0];
  const requestHash = taskSubmissionHash(command.body, command.groupGrantId);
  if (prior) {
    if (!prior.task_id || !prior.bot_version_id)
      throw new ConversationConflictError('idempotency_conflict');
    const target = await admitTaskTarget(
      connection,
      access,
      prior.group_grant_id,
      now,
      prior.bot_version_id,
    );
    await admitBotModel(
      connection,
      access.actorUserId,
      access.workspaceId,
      target.configuration.modelBinding,
    );
    if ((prior.request_hash ?? prior.command_hash) !== requestHash)
      throw new ConversationConflictError('idempotency_conflict');
    return {
      target,
      priorTaskId: prior.task_id,
      decision: null,
      groupId: subject.group_id,
      requestHash,
    };
  }
  let decision: RoutingDecision | null = null;
  let target: Awaited<ReturnType<typeof admitTaskTarget>>;
  if (subject.group_id) {
    const selected = await admitGroupLead(
      connection,
      { ...access, groupId: subject.group_id },
      {
        body: command.body,
        ...(command.groupGrantId ? { groupGrantId: command.groupGrantId } : {}),
      },
    );
    decision = selected.decision;
    target = {
      ...selected.target,
      conversation: await ConversationTransaction.lock(connection, access, now),
    };
  } else {
    target = await admitTaskTarget(connection, access, null, now);
  }
  await admitBotModel(
    connection,
    access.actorUserId,
    access.workspaceId,
    target.configuration.modelBinding,
  );
  return { target, priorTaskId: null, decision, groupId: subject.group_id, requestHash };
}
