import { describe, expect, it } from 'vitest';
import { parseHandoffAction } from '../../src/tasks/handoff-action.js';

const grantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('COL-16 handoff action admission', () => {
  it('accepts only a schema-valid handoff action', () => {
    expect(
      parseHandoffAction({
        type: 'action',
        id: 'call-1',
        name: 'handoff',
        arguments: { grantId, reason: 'A specialist should finish this.' },
      }),
    ).toEqual({ grantId, reason: 'A specialist should finish this.' });
  });

  it('rejects plain text, @mentions, and JSON-looking prose', () => {
    expect(parseHandoffAction('Please hand this to the specialist.')).toBeUndefined();
    expect(parseHandoffAction('Please ask @researcher to take over.')).toBeUndefined();
    expect(
      parseHandoffAction(
        JSON.stringify({
          type: 'action',
          name: 'handoff',
          arguments: { grantId, reason: 'A specialist should finish this.' },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseHandoffAction({
        type: 'complete',
        text: `{"name":"handoff","arguments":{"grantId":"${grantId}","reason":"Take over."}}`,
      }),
    ).toBeUndefined();
    expect(
      parseHandoffAction({
        type: 'action',
        id: 'call-1',
        name: 'delegate',
        arguments: { grantId, reason: 'A specialist should finish this.' },
      }),
    ).toBeUndefined();
    expect(
      parseHandoffAction({
        type: 'action',
        id: 'call-1',
        name: 'handoff',
        arguments: { grantId, reason: 'A specialist should finish this.', extra: true },
      }),
    ).toBeUndefined();
  });
});
