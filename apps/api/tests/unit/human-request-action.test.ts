import { describe, expect, it } from 'vitest';
import {
  parseRequestApprovalAction,
  parseRequestInputAction,
} from '../../src/tasks/human-request-action.js';
import { REQUEST_APPROVAL_TOOL, REQUEST_INPUT_TOOL } from '../../src/tasks/human-request.js';

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { answer: { type: 'string' } },
  required: ['answer'],
};

describe('COL-19 human request action admission', () => {
  it('exposes schema-valid request_input and request_approval tools', () => {
    expect(REQUEST_INPUT_TOOL.name).toBe('request_input');
    expect(REQUEST_INPUT_TOOL.parameters.required).toEqual(['prompt', 'responseSchema']);
    expect(REQUEST_APPROVAL_TOOL.name).toBe('request_approval');
    expect(REQUEST_APPROVAL_TOOL.parameters.required).toEqual(['summary']);
  });

  it('accepts only a schema-valid request_input action', () => {
    expect(
      parseRequestInputAction({
        type: 'action',
        id: 'call-1',
        name: 'request_input',
        arguments: { prompt: 'What is the deadline?', responseSchema },
      }),
    ).toEqual({ prompt: 'What is the deadline?', responseSchema });
  });

  it('accepts only a schema-valid request_approval action', () => {
    expect(
      parseRequestApprovalAction({
        type: 'action',
        id: 'call-2',
        name: 'request_approval',
        arguments: { summary: 'Post the weekly status update.' },
      }),
    ).toEqual({ summary: 'Post the weekly status update.' });
  });

  it('rejects plain text, @mentions, and JSON-looking prose', () => {
    expect(parseRequestInputAction('Please fill in the deadline.')).toBeUndefined();
    expect(parseRequestApprovalAction('Please ask @owner to approve.')).toBeUndefined();
    expect(
      parseRequestInputAction(
        JSON.stringify({
          type: 'action',
          name: 'request_input',
          arguments: { prompt: 'What is the deadline?', responseSchema },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseRequestInputAction({
        type: 'action',
        id: 'call-1',
        name: 'handoff',
        arguments: { prompt: 'What is the deadline?', responseSchema },
      }),
    ).toBeUndefined();
    expect(
      parseRequestInputAction({
        type: 'action',
        id: 'call-1',
        name: 'request_input',
        arguments: { prompt: 'What is the deadline?', responseSchema, extra: true },
      }),
    ).toBeUndefined();
    expect(
      parseRequestApprovalAction({
        type: 'action',
        id: 'call-2',
        name: 'request_approval',
        arguments: { summary: 'Post the weekly status update.', extra: true },
      }),
    ).toBeUndefined();
    expect(
      parseRequestInputAction({
        type: 'action',
        id: 'call-1',
        name: 'request_input',
        arguments: {
          prompt: 'What is the deadline?',
          responseSchema: { ...responseSchema, additionalProperties: true },
        },
      }),
    ).toBeUndefined();
  });
});
