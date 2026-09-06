export interface RunHistoryCursor {
  v: 1;
  conversationId: string;
  taskId: string;
  horizon: number;
  before: number;
}

export function encodeRunHistoryCursor(cursor: RunHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function runHistoryCursor(
  encoded: string | undefined,
  conversationId: string,
  taskId: string,
  maximum: number,
): RunHistoryCursor {
  if (encoded === undefined)
    return { v: 1, conversationId, taskId, horizon: maximum, before: maximum + 1 };
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new InvalidConversationInputError();
    const cursor = value as Record<string, unknown>;
    if (
      Object.keys(cursor).sort().join(',') !== 'before,conversationId,horizon,taskId,v' ||
      cursor.v !== 1 ||
      cursor.conversationId !== conversationId ||
      cursor.taskId !== taskId ||
      typeof cursor.horizon !== 'number' ||
      !Number.isSafeInteger(cursor.horizon) ||
      cursor.horizon < 1 ||
      cursor.horizon > maximum ||
      typeof cursor.before !== 'number' ||
      !Number.isSafeInteger(cursor.before) ||
      cursor.before < 1 ||
      cursor.before > cursor.horizon + 1
    )
      throw new InvalidConversationInputError();
    return { v: 1, conversationId, taskId, horizon: cursor.horizon, before: cursor.before };
  } catch {
    throw new InvalidConversationInputError();
  }
}
import { InvalidConversationInputError } from '../conversations/service.js';
