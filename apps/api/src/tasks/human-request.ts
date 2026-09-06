export const REQUEST_INPUT_TOOL_NAME = 'request_input';
export const REQUEST_APPROVAL_TOOL_NAME = 'request_approval';

export const REQUEST_INPUT_TOOL = Object.freeze({
  name: REQUEST_INPUT_TOOL_NAME,
  description: 'Pause this Task and ask an authorized human for structured input.',
  parameters: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['prompt', 'responseSchema']),
    properties: Object.freeze({
      prompt: Object.freeze({ type: 'string', minLength: 1, maxLength: 8000 }),
      responseSchema: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['type', 'additionalProperties', 'properties', 'required']),
        properties: Object.freeze({
          type: Object.freeze({ const: 'object' }),
          additionalProperties: Object.freeze({ const: false }),
          properties: Object.freeze({ type: 'object' }),
          required: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
        }),
      }),
    }),
  }),
});

export const REQUEST_APPROVAL_TOOL = Object.freeze({
  name: REQUEST_APPROVAL_TOOL_NAME,
  description: 'Pause this Task and ask an authorized human to approve or reject an action.',
  parameters: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['summary']),
    properties: Object.freeze({
      summary: Object.freeze({ type: 'string', minLength: 1, maxLength: 8000 }),
    }),
  }),
});
