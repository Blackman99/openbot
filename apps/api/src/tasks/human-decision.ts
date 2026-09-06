import { TaskInputError } from './errors.js';
import type { HumanInputSchema } from './human-request-action.js';

export type HumanInputDecision = {
  idempotencyKey: string;
  values: Record<string, string | number | boolean>;
};

export type HumanApprovalDecision = {
  idempotencyKey: string;
  decision: 'approve' | 'reject';
};

const IDEMPOTENCY = /^[\x21-\x7e]{1,128}$/u;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY.test(value)) throw new TaskInputError();
  return value;
}

export function parseHumanInputDecision(
  schema: HumanInputSchema,
  input: unknown,
): HumanInputDecision {
  if (!object(input) || Object.keys(input).sort().join(',') !== 'idempotencyKey,values')
    throw new TaskInputError();
  if (!object(input.values)) throw new TaskInputError();
  const submitted = input.values;
  const names = Object.keys(submitted);
  if (names.some((name) => !schema.properties[name])) throw new TaskInputError();
  if (schema.required.some((name) => !(name in submitted))) throw new TaskInputError();
  const values: Record<string, string | number | boolean> = {};
  for (const name of names) {
    const field = schema.properties[name]!;
    const value = submitted[name];
    if (
      field.type === 'string' &&
      typeof value === 'string' &&
      value.trim() &&
      value.length <= 8000
    )
      values[name] = value.trim();
    else if (field.type === 'number' && typeof value === 'number' && Number.isFinite(value))
      values[name] = value;
    else if (field.type === 'boolean' && typeof value === 'boolean') values[name] = value;
    else throw new TaskInputError();
  }
  return { idempotencyKey: idempotencyKey(input.idempotencyKey), values };
}

export function parseHumanApprovalDecision(input: unknown): HumanApprovalDecision {
  if (!object(input) || Object.keys(input).sort().join(',') !== 'decision,idempotencyKey')
    throw new TaskInputError();
  if (input.decision !== 'approve' && input.decision !== 'reject') throw new TaskInputError();
  return { idempotencyKey: idempotencyKey(input.idempotencyKey), decision: input.decision };
}
