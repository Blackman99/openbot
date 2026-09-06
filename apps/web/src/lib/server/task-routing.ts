import type { TaskView } from './task-contract.js';
import { createRoutingDecisionApiClient } from './routing-decision-api.js';
import type { RoutingDecision } from '../routing-contract.js';
import type { RoutingResult } from './routing-http.js';

// A full decision is loaded only for one already-admitted Task. Its pinned target
// must agree with that Task; a same-reason receipt from another Task is not valid.
export async function readTaskRoutingDecision(
  request: typeof fetch,
  session: string | undefined,
  workspaceId: string,
  conversationId: string,
  task: TaskView,
  signal?: AbortSignal,
): Promise<RoutingResult<RoutingDecision | null>> {
  const result = await createRoutingDecisionApiClient(request, signal).getForTask(
    session,
    workspaceId,
    conversationId,
    task,
  );
  if (result.status !== 'available' || result.value === null) return result;
  const { lead } = result.value;
  return lead.botId === task.bot.id &&
    lead.versionId === task.bot.versionId &&
    lead.grantId === task.groupGrantId &&
    lead.name === task.bot.name
    ? result
    : { status: 'unavailable' };
}
