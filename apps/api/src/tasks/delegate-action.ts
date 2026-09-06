const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface DelegateAction {
  grantId: string;
  body: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDelegateAction(input: unknown): DelegateAction | undefined {
  if (!object(input) || input.type !== 'action' || input.name !== 'delegate') return undefined;
  if (typeof input.id !== 'string' || !input.id) return undefined;
  const extra = Object.keys(input).filter(
    (key) => !['type', 'id', 'name', 'arguments'].includes(key),
  );
  if (extra.length || !object(input.arguments)) return undefined;
  if (Object.keys(input.arguments).sort().join(',') !== 'body,grantId') return undefined;
  const grantId = input.arguments.grantId;
  const body = input.arguments.body;
  if (typeof grantId !== 'string' || !uuid.test(grantId)) return undefined;
  if (typeof body !== 'string' || !body.trim() || body.length > 8000) return undefined;
  return { grantId: grantId.toLowerCase(), body: body.trim() };
}
