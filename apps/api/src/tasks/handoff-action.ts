const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface HandoffAction {
  grantId: string;
  reason: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHandoffAction(input: unknown): HandoffAction | undefined {
  if (!object(input) || input.type !== 'action' || input.name !== 'handoff') return undefined;
  if (typeof input.id !== 'string' || !input.id) return undefined;
  const extra = Object.keys(input).filter(
    (key) => !['type', 'id', 'name', 'arguments'].includes(key),
  );
  if (extra.length || !object(input.arguments)) return undefined;
  if (Object.keys(input.arguments).sort().join(',') !== 'grantId,reason') return undefined;
  const grantId = input.arguments.grantId;
  const reason = input.arguments.reason;
  if (typeof grantId !== 'string' || !uuid.test(grantId)) return undefined;
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 8000) return undefined;
  return { grantId: grantId.toLowerCase(), reason: reason.trim() };
}
