export const HANDOFF_TOOL_NAME = 'handoff';

export const HANDOFF_TOOL = Object.freeze({
  name: HANDOFF_TOOL_NAME,
  description: 'Transfer this Task to another active Bot in the current group.',
  parameters: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['grantId', 'reason']),
    properties: Object.freeze({
      grantId: Object.freeze({ type: 'string', format: 'uuid' }),
      reason: Object.freeze({ type: 'string', minLength: 1, maxLength: 8000 }),
    }),
  }),
});
