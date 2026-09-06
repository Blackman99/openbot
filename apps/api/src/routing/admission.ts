import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import { BotModelError } from '../bots/service.js';
import { admitBotModel } from '../bots/model-binding.js';
import { conversationUuid, type ConversationAccess } from '../conversations/service.js';
import { GroupBotTransaction } from '../group-bots/postgres-admission.js';
import { groupBotAccess, groupBotUuid, GroupBotAccessError } from '../group-bots/service.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import { chooseLead, type RoutingCandidate } from './matcher.js';

// The caller owns the transaction through its dependent Task and audit writes.
// Prelock every candidate Bot before any conversation/provider lock is acquired.
export async function admitGroupLead(
  connection: SqlConnection,
  supplied: ConversationAccess & { groupId: string },
  input: { body: string; groupGrantId?: string },
) {
  const access = groupBotAccess(supplied.actorUserId, supplied.workspaceId, supplied.groupId);
  const conversationId = conversationUuid(supplied.conversationId);
  const mentionedGrantId =
    input.groupGrantId === undefined ? undefined : groupBotUuid(input.groupGrantId);
  await lockAuthorizedGroup(
    connection,
    {
      actorId: access.actorUserId,
      workspaceId: access.workspaceId,
      groupId: access.groupId,
    },
    'content',
  );
  const grants = (
    await connection.query<{ id: string; bot_id: string }>(
      'SELECT id,bot_id FROM group_bot_grants WHERE workspace_id=$1 AND group_id=$2 AND close_event_id IS NULL ORDER BY bot_id,id LIMIT 9',
      [access.workspaceId, access.groupId],
    )
  ).rows;
  if (grants.length > 8) throw new Error('Active group grant bound exceeded');
  for (const grant of grants) {
    await connection.query('SELECT id FROM bots WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
      access.workspaceId,
      grant.bot_id,
    ]);
  }
  if (
    !(
      await connection.query(
        'SELECT id FROM conversations WHERE workspace_id=$1 AND group_id=$2 AND id=$3 FOR UPDATE',
        [access.workspaceId, access.groupId, conversationId],
      )
    ).rows[0]
  )
    throw new GroupBotAccessError();

  const targets = new Map<string, Awaited<ReturnType<GroupBotTransaction['executionTarget']>>>();
  const candidates: RoutingCandidate[] = [];
  for (const row of grants) {
    try {
      const grant = await GroupBotTransaction.lock(connection, { ...access, grantId: row.id });
      const target = await grant.executionTarget();
      if (target.conversationId !== conversationId) throw new GroupBotAccessError();
      await admitBotModel(
        connection,
        access.actorUserId,
        access.workspaceId,
        target.configuration.modelBinding,
      );
      targets.set(row.id, target);
      candidates.push({
        botId: target.botId,
        grantId: row.id,
        versionId: target.versionId,
        name: target.configuration.name,
        roleDescription: target.configuration.roleDescription,
        description: target.configuration.description,
      });
    } catch (error) {
      if (!(error instanceof GroupBotAccessError || error instanceof BotModelError)) throw error;
      if (row.id === mentionedGrantId) throw error;
    }
  }
  if (mentionedGrantId && !targets.has(mentionedGrantId)) throw new GroupBotAccessError();
  const setting = (
    await connection.query<{ default_grant_id: string | null }>(
      'SELECT default_grant_id FROM group_routing_settings WHERE group_id=$1',
      [access.groupId],
    )
  ).rows[0];
  const decision = chooseLead({
    body: input.body,
    ...(mentionedGrantId ? { mentionedGrantId } : {}),
    defaultGrantId: setting?.default_grant_id ?? null,
    candidates,
  });
  return { target: targets.get(decision.lead.grantId)!, decision };
}
