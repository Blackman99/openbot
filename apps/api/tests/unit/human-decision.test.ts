import { describe, expect, it } from 'vitest';
import { TaskInputError } from '../../src/tasks/errors.js';
import {
  parseHumanApprovalDecision,
  parseHumanInputDecision,
} from '../../src/tasks/human-decision.js';
import type { HumanInputSchema } from '../../src/tasks/human-request-action.js';

const schema: HumanInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { answer: { type: 'string' }, count: { type: 'number' } },
  required: ['answer'],
};

describe('COL-19 human decision admission', () => {
  it('accepts values that match the request schema', () => {
    expect(
      parseHumanInputDecision(schema, {
        idempotencyKey: 'input-1',
        values: { answer: ' Friday ', count: 2 },
      }),
    ).toEqual({ idempotencyKey: 'input-1', values: { answer: 'Friday', count: 2 } });
    expect(parseHumanApprovalDecision({ idempotencyKey: 'ok-1', decision: 'approve' })).toEqual({
      idempotencyKey: 'ok-1',
      decision: 'approve',
    });
  });

  it('rejects extra keys, missing required fields, and bot-shaped payloads', () => {
    expect(() =>
      parseHumanInputDecision(schema, { idempotencyKey: 'input-1', values: { count: 2 } }),
    ).toThrow(TaskInputError);
    expect(() =>
      parseHumanInputDecision(schema, {
        idempotencyKey: 'input-1',
        values: { answer: 'Friday', extra: true },
      }),
    ).toThrow(TaskInputError);
    expect(() =>
      parseHumanApprovalDecision({ idempotencyKey: 'ok-1', decision: 'approve', extra: true }),
    ).toThrow(TaskInputError);
    expect(() => parseHumanApprovalDecision({ idempotencyKey: 'ok-1', decision: 'maybe' })).toThrow(
      TaskInputError,
    );
  });
});
