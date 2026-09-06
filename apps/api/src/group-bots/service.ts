import type { BotLifecycleState } from '../bots/service.js';
import type { TransactionAdmission } from '../database/transaction-admission.js';
import {
  conversationUuid,
  InvalidConversationInputError,
  messageRead,
  type MessageProjection,
  type MessageRead,
} from '../conversations/service.js';
export class GroupBotInputError extends Error {}
export class GroupBotAccessError extends Error {}
export class GroupBotConflictError extends Error {
  constructor(
    readonly code:
      | 'idempotency_conflict'
      | 'group_bot_already_active'
      | 'group_bot_limit'
      | 'group_bot_inactive',
  ) {
    super(code);
  }
}
export interface GroupBotAccess {
  actorUserId: string;
  workspaceId: string;
  groupId: string;
}
export interface GroupBotGrant {
  id: string;
  groupId: string;
  conversationId: string;
  bot: {
    lifecycleState: BotLifecycleState;
    id: string;
    name: string;
    roleDescription: string;
    description: string;
    canInspect: boolean;
  };
  grantedBy: { id: string; displayName: string };
  history: GroupBotHistory & { lowerBound: number };
  joined: { eventId: string; sequence: number; at: Date };
  closed: { eventId: string; sequence: number; at: Date; reason: GroupBotClosureReason } | null;
}
export type GroupBotClosureReason = 'removed' | 'bot-access-revoked' | 'workspace-access-removed';
export interface GroupBotList {
  groupId: string;
  grants: GroupBotGrant[];
  activeCount: number;
  maxActive: number;
  canManage: boolean;
}
export interface GroupBotInvite {
  botId: string;
  idempotencyKey: string;
  history: GroupBotHistory;
}
export type GroupBotHistory =
  | { mode: 'future-only' | 'all' }
  | { mode: 'since-event'; eventId: string }
  | { mode: 'since-time'; time: string };
function historyChoice(value: unknown): GroupBotHistory {
  if (value === undefined || value === 'future' || value === 'future-only')
    return { mode: 'future-only' };
  if (value === 'all') return { mode: 'all' };
  const input = groupBotObject(value, ['mode', 'eventId', 'time']);
  if (input.mode === 'future') input.mode = 'future-only';
  if (input.mode === 'since' && 'eventId' in input) input.mode = 'since-event';
  if (input.mode === 'since' && 'time' in input) input.mode = 'since-time';
  if ((input.mode === 'future-only' || input.mode === 'all') && Object.keys(input).length === 1)
    return { mode: input.mode };
  if (input.mode === 'since-event' && Object.keys(input).length === 2 && 'eventId' in input)
    return { mode: input.mode, eventId: groupBotUuid(input.eventId) };
  if (
    input.mode === 'since-time' &&
    Object.keys(input).length === 2 &&
    typeof input.time === 'string' &&
    Number.isFinite(Date.parse(input.time)) &&
    new Date(input.time).toISOString() === input.time
  )
    return { mode: input.mode, time: input.time };
  throw new GroupBotInputError();
}
export interface GroupBotRepository {
  invite(
    access: GroupBotAccess,
    command: GroupBotInvite,
    admission?: TransactionAdmission,
  ): Promise<GroupBotGrant>;
  list(access: GroupBotAccess, admission?: TransactionAdmission): Promise<GroupBotList>;
  context(access: GroupBotAccess, grantId: string, read: MessageRead): Promise<GroupBotContext>;
  remove(
    access: GroupBotAccess,
    grantId: string,
    idempotencyKey: string,
    admission?: TransactionAdmission,
  ): Promise<GroupBotGrant>;
}
export interface GroupBotContext {
  grantId: string;
  conversationId: string;
  messages: MessageProjection[];
  nextCursor: string | null;
}
export function groupBotUuid(value: unknown) {
  try {
    return conversationUuid(value);
  } catch (error) {
    if (error instanceof InvalidConversationInputError) throw new GroupBotInputError();
    throw error;
  }
}
export function groupBotObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new GroupBotInputError();
  return value as Record<string, unknown>;
}
export function groupBotCommandKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,128}$/u.test(value))
    throw new GroupBotInputError();
  return value;
}
export function groupBotAccess(actorUserId: string, workspaceId: string, groupId: string) {
  return Object.freeze({
    actorUserId: groupBotUuid(actorUserId),
    workspaceId: groupBotUuid(workspaceId),
    groupId: groupBotUuid(groupId),
  });
}
export class GroupBotService {
  constructor(private readonly repository: GroupBotRepository) {}
  invite(
    actor: string,
    workspace: string,
    group: string,
    value: unknown,
    admission?: TransactionAdmission,
  ) {
    const input = groupBotObject(value, [
      'botId',
      'idempotencyKey',
      'history',
      'historyAccess',
      'eventId',
      'time',
    ]);
    const history =
      input.history ??
      (input.historyAccess === 'all'
        ? { mode: 'all' }
        : input.historyAccess === 'since'
          ? 'eventId' in input
            ? { mode: 'since-event', eventId: input.eventId }
            : { mode: 'since-time', time: input.time }
          : input.historyAccess === 'future' || input.historyAccess === undefined
            ? undefined
            : input.historyAccess);
    return this.repository.invite(
      groupBotAccess(actor, workspace, group),
      {
        botId: groupBotUuid(input.botId),
        idempotencyKey:
          input.idempotencyKey === undefined
            ? `${Date.now()}-${groupBotUuid(input.botId)}`
            : groupBotCommandKey(input.idempotencyKey),
        history: historyChoice(history),
      },
      admission,
    );
  }
  list(actor: string, workspace: string, group: string, admission?: TransactionAdmission) {
    return this.repository.list(groupBotAccess(actor, workspace, group), admission);
  }
  context(actor: string, workspace: string, group: string, grantId: string, query: unknown) {
    let read: MessageRead;
    try {
      read = messageRead(query);
    } catch (error) {
      if (error instanceof InvalidConversationInputError) throw new GroupBotInputError();
      throw error;
    }
    return this.repository.context(
      groupBotAccess(actor, workspace, group),
      groupBotUuid(grantId),
      read,
    );
  }
  remove(
    actor: string,
    workspace: string,
    group: string,
    grantId: string,
    value: unknown,
    admission?: TransactionAdmission,
  ) {
    const input = groupBotObject(value ?? { idempotencyKey: grantId }, ['idempotencyKey']);
    return this.repository.remove(
      groupBotAccess(actor, workspace, group),
      groupBotUuid(grantId),
      groupBotCommandKey(input.idempotencyKey === undefined ? grantId : input.idempotencyKey),
      admission,
    );
  }
}
