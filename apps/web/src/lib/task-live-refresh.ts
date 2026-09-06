import type { ConversationStreamEvent } from './conversation-stream-contract.js';

/** Events that change task status, approvals, retries, or human-request UI. */
const REFRESH_TYPES = new Set<ConversationStreamEvent['type']>([
  'task.human.decided',
  'task.approval.requested',
  'task.input.requested',
  'task.run.updated',
]);

/**
 * Returns true when a conversation stream event should reload task list/detail
 * page data so API-driven approvals and retries appear without a full refresh.
 */
export function shouldRefreshTaskUi(event: ConversationStreamEvent, taskId?: string): boolean {
  if (!REFRESH_TYPES.has(event.type)) return false;
  if (!taskId) return true;
  if (event.type === 'task.run.updated') return event.data.execution.taskId === taskId;
  if (
    event.type === 'task.human.decided' ||
    event.type === 'task.approval.requested' ||
    event.type === 'task.input.requested'
  )
    return event.data.taskId === taskId;
  return false;
}
