import { InvalidConversationInputError } from './service.js';
export interface MessageCursor {
  v: 1;
  conversationId: string;
  after: number;
  horizon: number;
}
export function messageCursor(
  encoded: string | undefined,
  conversationId: string,
  lastSequence: number,
): MessageCursor {
  if (encoded === undefined) return { v: 1, conversationId, after: 0, horizon: lastSequence };
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new InvalidConversationInputError();
    const item = value as Record<string, unknown>;
    if (
      Object.keys(item).length !== 4 ||
      item.v !== 1 ||
      item.conversationId !== conversationId ||
      typeof item.after !== 'number' ||
      !Number.isSafeInteger(item.after) ||
      item.after < 0 ||
      typeof item.horizon !== 'number' ||
      !Number.isSafeInteger(item.horizon) ||
      item.horizon < item.after ||
      item.horizon > lastSequence
    )
      throw new InvalidConversationInputError();
    return { v: 1, conversationId, after: item.after, horizon: item.horizon };
  } catch {
    throw new InvalidConversationInputError();
  }
}
export function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
