import type { RequiredCapability } from '../providers/capability-policy.js';
import {
  DEFAULT_BOT_LIMITS,
  parseBotBinding,
  parseBotConfiguration,
  type BotBinding,
  type BotConfiguration,
  type BotLimits,
  type BotRetryPolicy,
} from './service.js';

export const BOT_TEMPLATE_SCHEMA_VERSION = 'openbot.bot-template.v1';

const FORBIDDEN_FIELDS = new Set([
  'apikey',
  'attachment',
  'attachmentbody',
  'attachmentid',
  'avatarobjectid',
  'backendid',
  'connectionid',
  'connectionrevision',
  'conversation',
  'conversationhistory',
  'conversationid',
  'credential',
  'filecontents',
  'headers',
  'history',
  'memory',
  'memoryid',
  'objectid',
  'objectreference',
  'password',
  'privatememory',
  'privatememoryid',
  'sealedcredentials',
  'secret',
  'sourcebotid',
  'sourceworkspaceid',
  'storageid',
  'storedobject',
  'token',
]);

const TEMPLATE_KEYS = [
  'schemaVersion',
  'identity',
  'instructions',
  'capabilities',
  'collaboration',
  'budgets',
  'retryPolicy',
] as const;

export type BotTemplateFieldError = { field: string; code: string };

export class BotTemplateError extends Error {
  constructor(readonly fields: readonly BotTemplateFieldError[]) {
    super('invalid_bot_template');
  }
}

export interface BotTemplate {
  schemaVersion: typeof BOT_TEMPLATE_SCHEMA_VERSION;
  identity: { name: string; roleDescription: string; description: string };
  instructions: string;
  capabilities: { required: RequiredCapability };
  collaboration: { visibility: 'private' | 'workspace' };
  budgets: BotLimits;
  retryPolicy?: BotRetryPolicy;
}

export interface BotTemplateDifference {
  field: string;
  template: unknown;
  local: unknown;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function forbiddenFields(value: unknown, path = ''): BotTemplateFieldError[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) => forbiddenFields(item, `${path}[${index}]`));
  if (!object(value)) return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const field = path ? `${path}.${key}` : key;
    const errors = FORBIDDEN_FIELDS.has(key.toLowerCase())
      ? [{ field, code: 'forbidden_field' }]
      : [];
    return [...errors, ...forbiddenFields(nested, field)];
  });
}

function parseRetryPolicy(input: unknown): BotRetryPolicy | BotTemplateFieldError[] {
  if (
    !object(input) ||
    Object.keys(input).some((key) => !['maxAttemptsPerModel', 'maxRunsPerChain'].includes(key))
  )
    return [{ field: 'retryPolicy', code: 'malformed' }];
  try {
    return parseBotConfiguration({
      name: 'Template',
      roleDescription: 'Imported template',
      description: '',
      instructions: 'Imported template instructions.',
      modelBinding: {
        scope: { kind: 'personal', id: '11111111-1111-4111-8111-111111111111' },
        connectionId: '22222222-2222-4222-8222-222222222222',
        modelId: 'probe',
      },
      limits: DEFAULT_BOT_LIMITS,
      retryPolicy: input,
    }).retryPolicy!;
  } catch {
    return [{ field: 'retryPolicy', code: 'malformed' }];
  }
}

export function parseBotTemplate(input: unknown): BotTemplate {
  const forbidden = forbiddenFields(input);
  if (forbidden.length) throw new BotTemplateError(forbidden);
  if (!object(input)) throw new BotTemplateError([{ field: '', code: 'malformed' }]);
  const errors: BotTemplateFieldError[] = [];
  for (const key of Object.keys(input)) {
    if (!TEMPLATE_KEYS.includes(key as (typeof TEMPLATE_KEYS)[number]))
      errors.push({ field: key, code: 'unknown_field' });
  }
  if (input.schemaVersion !== BOT_TEMPLATE_SCHEMA_VERSION)
    errors.push({ field: 'schemaVersion', code: 'unsupported_schema' });
  const identity = input.identity;
  if (
    !object(identity) ||
    Object.keys(identity).some((key) => !['name', 'roleDescription', 'description'].includes(key))
  )
    errors.push({ field: 'identity', code: 'malformed' });
  const capabilities = input.capabilities;
  if (
    !object(capabilities) ||
    Object.keys(capabilities).join(',') !== 'required' ||
    (capabilities.required !== 'basic' &&
      capabilities.required !== 'collaboration' &&
      capabilities.required !== 'visionInput')
  )
    errors.push({ field: 'capabilities', code: 'malformed' });
  const collaboration = input.collaboration;
  if (
    !object(collaboration) ||
    Object.keys(collaboration).join(',') !== 'visibility' ||
    (collaboration.visibility !== 'private' && collaboration.visibility !== 'workspace')
  )
    errors.push({ field: 'collaboration', code: 'malformed' });
  if (
    typeof input.instructions !== 'string' ||
    !input.instructions.trim() ||
    input.instructions.length > 32000
  )
    errors.push({ field: 'instructions', code: 'malformed' });
  let budgets = DEFAULT_BOT_LIMITS;
  try {
    budgets = parseBotConfiguration({
      name: 'Template',
      roleDescription: 'Imported template',
      description: '',
      instructions: 'Imported template instructions.',
      modelBinding: {
        scope: { kind: 'personal', id: '11111111-1111-4111-8111-111111111111' },
        connectionId: '22222222-2222-4222-8222-222222222222',
        modelId: 'probe',
      },
      limits: input.budgets ?? DEFAULT_BOT_LIMITS,
    }).limits;
  } catch {
    errors.push({ field: 'budgets', code: 'malformed' });
  }
  let retryPolicy: BotRetryPolicy | undefined;
  if ('retryPolicy' in input) {
    const parsed = parseRetryPolicy(input.retryPolicy);
    if (Array.isArray(parsed)) errors.push(...parsed);
    else retryPolicy = parsed;
  }
  if (errors.length) throw new BotTemplateError(errors);
  const named = identity as Record<string, unknown>;
  if (
    typeof named.name !== 'string' ||
    !named.name.trim() ||
    named.name.trim().length > 100 ||
    typeof named.roleDescription !== 'string' ||
    !named.roleDescription.trim() ||
    named.roleDescription.trim().length > 200 ||
    typeof named.description !== 'string' ||
    named.description.length > 2000
  )
    throw new BotTemplateError([{ field: 'identity', code: 'malformed' }]);
  return {
    schemaVersion: BOT_TEMPLATE_SCHEMA_VERSION,
    identity: {
      name: named.name.trim(),
      roleDescription: named.roleDescription.trim(),
      description: named.description.trim(),
    },
    instructions: input.instructions as string,
    capabilities: { required: (capabilities as { required: RequiredCapability }).required },
    collaboration: {
      visibility: (collaboration as { visibility: 'private' | 'workspace' }).visibility,
    },
    budgets,
    ...(retryPolicy ? { retryPolicy } : {}),
  };
}

export function exportBotTemplate(input: {
  configuration: BotConfiguration;
  visibility: 'private' | 'workspace';
}): BotTemplate {
  return parseBotTemplate({
    schemaVersion: BOT_TEMPLATE_SCHEMA_VERSION,
    identity: {
      name: input.configuration.name,
      roleDescription: input.configuration.roleDescription,
      description: input.configuration.description,
    },
    instructions: input.configuration.instructions,
    capabilities: { required: 'basic' },
    collaboration: { visibility: input.visibility },
    budgets: input.configuration.limits,
    ...(input.configuration.retryPolicy ? { retryPolicy: input.configuration.retryPolicy } : {}),
  });
}

export function templateContainsSecrets(template: BotTemplate): boolean {
  return forbiddenFields(template).length > 0;
}

export function templateConfiguration(
  template: BotTemplate,
  modelBinding: unknown,
): BotConfiguration {
  return parseBotConfiguration({
    name: template.identity.name,
    roleDescription: template.identity.roleDescription,
    description: template.identity.description,
    instructions: template.instructions,
    modelBinding,
    limits: template.budgets,
    ...(template.retryPolicy ? { retryPolicy: template.retryPolicy } : {}),
  });
}

export function parseImportBinding(input: unknown): BotBinding {
  return parseBotBinding(input);
}

export function templateDifferences(
  template: BotTemplate,
  local: BotConfiguration,
): BotTemplateDifference[] {
  const rows: BotTemplateDifference[] = [];
  const pairs: Array<[string, unknown, unknown]> = [
    ['identity.name', template.identity.name, local.name],
    ['identity.roleDescription', template.identity.roleDescription, local.roleDescription],
    ['identity.description', template.identity.description, local.description],
    ['instructions', template.instructions, local.instructions],
    ['budgets.maxTotalTokens', template.budgets.maxTotalTokens, local.limits.maxTotalTokens],
    [
      'budgets.maxDurationSeconds',
      template.budgets.maxDurationSeconds,
      local.limits.maxDurationSeconds,
    ],
    ['budgets.maxTurns', template.budgets.maxTurns, local.limits.maxTurns],
    [
      'budgets.maxDelegationDepth',
      template.budgets.maxDelegationDepth,
      local.limits.maxDelegationDepth,
    ],
  ];
  for (const [field, left, right] of pairs) {
    if (left !== right) rows.push({ field, template: left, local: right });
  }
  return rows;
}
