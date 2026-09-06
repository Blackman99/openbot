import { describe, expect, it } from 'vitest';
import { parseDelegateAction } from '../../src/tasks/delegate-action.js';

const grantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('COL-14 delegate action admission', () => {
  it('accepts only a schema-valid delegate action', () => {
    expect(
      parseDelegateAction({
        type: 'action',
        id: 'call-1',
        name: 'delegate',
        arguments: { grantId, body: 'Summarize the sources.' },
      }),
    ).toEqual({ grantId, body: 'Summarize the sources.' });
  });

  it('rejects plain text, @mentions, and JSON-looking prose', () => {
    expect(parseDelegateAction('Summarize the sources.')).toBeUndefined();
    expect(parseDelegateAction('Please ask @researcher to look this up.')).toBeUndefined();
    expect(
      parseDelegateAction(
        JSON.stringify({
          type: 'action',
          name: 'delegate',
          arguments: { grantId, body: 'Summarize the sources.' },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseDelegateAction({
        type: 'complete',
        text: `{"name":"delegate","arguments":{"grantId":"${grantId}","body":"Summarize the sources."}}`,
      }),
    ).toBeUndefined();
    expect(
      parseDelegateAction({
        type: 'action',
        id: 'call-1',
        name: 'search',
        arguments: { grantId, body: 'Summarize the sources.' },
      }),
    ).toBeUndefined();
    expect(
      parseDelegateAction({
        type: 'action',
        id: 'call-1',
        name: 'delegate',
        arguments: { grantId, body: 'Summarize the sources.', extra: true },
      }),
    ).toBeUndefined();
  });
});
