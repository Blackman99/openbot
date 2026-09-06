export interface PendingConversationCommand {
  readonly scope: string;
  readonly action: 'edit' | 'saveMemory';
  readonly messageId: string;
  readonly values: Readonly<Record<string, string>>;
}

export function pendingCommandMatches(
  command: PendingConversationCommand | null,
  scope: string,
  action: string,
  messageId: string,
) {
  return command?.scope === scope && command.action === action && command.messageId === messageId;
}

// One bounded submitted intent lives outside the replaceable stream projection.
// A retry sends those exact fields even if the DOM or current source has changed.
export function preparePendingConversationCommand(
  pending: PendingConversationCommand | null,
  scope: string,
  actionUrl: URL,
  form: FormData,
):
  | { status: 'unmanaged' | 'busy' | 'invalid' }
  | { status: 'ready'; command: PendingConversationCommand } {
  const action = actionUrl.searchParams.has('/saveMemory')
    ? 'saveMemory'
    : actionUrl.searchParams.has('/edit')
      ? 'edit'
      : undefined;
  if (!action) return { status: 'unmanaged' };
  const messageId = form.get('messageId');
  if (typeof messageId !== 'string' || !messageId) return { status: 'invalid' };
  if (pending) {
    if (!pendingCommandMatches(pending, scope, action, messageId)) return { status: 'busy' };
    for (const [name, value] of Object.entries(pending.values)) form.set(name, value);
    return { status: 'ready', command: pending };
  }
  const fields =
    action === 'saveMemory'
      ? ['groupId', 'messageId', 'expectedSourceEventId', 'idempotencyKey', 'confidence']
      : ['messageId', 'expectedVersion', 'idempotencyKey', 'body'];
  const values: Record<string, string> = {};
  for (const name of fields) {
    const value = form.get(name);
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > (name === 'body' ? 32000 : 800) ||
      form.getAll(name).length !== 1
    )
      return { status: 'invalid' };
    values[name] = value;
  }
  return { status: 'ready', command: { scope, action, messageId, values } };
}
