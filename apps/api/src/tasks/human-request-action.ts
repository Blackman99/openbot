export type HumanInputField = {
  type: 'string' | 'number' | 'boolean';
};

export type HumanInputSchema = {
  type: 'object';
  additionalProperties: false;
  properties: Record<string, HumanInputField>;
  required: string[];
};

export interface RequestInputAction {
  prompt: string;
  responseSchema: HumanInputSchema;
}

export interface RequestApprovalAction {
  summary: string;
}

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const MAX_FIELDS = 16;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function actionArguments(
  input: unknown,
  name: 'request_input' | 'request_approval',
): Record<string, unknown> | undefined {
  if (!object(input) || input.type !== 'action' || input.name !== name) return undefined;
  if (typeof input.id !== 'string' || !input.id) return undefined;
  const extra = Object.keys(input).filter(
    (key) => !['type', 'id', 'name', 'arguments'].includes(key),
  );
  if (extra.length || !object(input.arguments)) return undefined;
  return input.arguments;
}

function parseField(value: unknown): HumanInputField | undefined {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'type') return undefined;
  if (value.type !== 'string' && value.type !== 'number' && value.type !== 'boolean')
    return undefined;
  return { type: value.type };
}

export function parseHumanInputSchema(value: unknown): HumanInputSchema | undefined {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'additionalProperties,properties,required,type'
  )
    return undefined;
  if (value.type !== 'object' || value.additionalProperties !== false || !object(value.properties))
    return undefined;
  if (!Array.isArray(value.required) || value.required.some((item) => typeof item !== 'string'))
    return undefined;
  const names = Object.keys(value.properties);
  if (!names.length || names.length > MAX_FIELDS) return undefined;
  const properties: Record<string, HumanInputField> = {};
  for (const name of names) {
    if (!FIELD_NAME.test(name)) return undefined;
    const field = parseField(value.properties[name]);
    if (!field) return undefined;
    properties[name] = field;
  }
  const required = value.required as string[];
  if (new Set(required).size !== required.length) return undefined;
  if (required.some((name) => !properties[name])) return undefined;
  return { type: 'object', additionalProperties: false, properties, required };
}

export function parseRequestInputAction(input: unknown): RequestInputAction | undefined {
  const args = actionArguments(input, 'request_input');
  if (!args || Object.keys(args).sort().join(',') !== 'prompt,responseSchema') return undefined;
  if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 8000)
    return undefined;
  const responseSchema = parseHumanInputSchema(args.responseSchema);
  if (!responseSchema) return undefined;
  return { prompt: args.prompt.trim(), responseSchema };
}

export function parseRequestApprovalAction(input: unknown): RequestApprovalAction | undefined {
  const args = actionArguments(input, 'request_approval');
  if (!args || Object.keys(args).sort().join(',') !== 'summary') return undefined;
  if (typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 8000)
    return undefined;
  return { summary: args.summary.trim() };
}
