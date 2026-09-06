import {
  BotTemplateError,
  exportBotTemplate,
  parseBotTemplate,
  type BotTemplate,
} from '../bots/template.js';
import type { BotConfiguration } from '../bots/service.js';
import { parseExecutionPolicy, type ExecutionLimitPolicy } from '../tasks/execution-limits.js';

export const TEAM_TEMPLATE_SCHEMA_VERSION = 'openbot.team-template.v1';

const FORBIDDEN_FIELDS = new Set([
  'apikey',
  'attachment',
  'attachmentbody',
  'attachmentid',
  'avatarobjectid',
  'connectionid',
  'conversation',
  'conversationhistory',
  'conversationid',
  'credential',
  'email',
  'filebody',
  'filecontents',
  'grantid',
  'headers',
  'history',
  'members',
  'memories',
  'memory',
  'password',
  'privatememory',
  'secret',
  'sourcebotid',
  'sourcegroupid',
  'sourceworkspaceid',
  'userid',
  'users',
]);

const TEMPLATE_KEYS = [
  'schemaVersion',
  'identity',
  'bots',
  'roles',
  'defaultLead',
  'collaboration',
  'budgets',
] as const;

const BUDGET_KEYS = [
  'maxDurationSeconds',
  'maxTurns',
  'maxDelegationDepth',
  'maxHandoffs',
] as const;

export type TeamTemplateFieldError = { field: string; code: string };

export class TeamTemplateError extends Error {
  constructor(readonly fields: readonly TeamTemplateFieldError[]) {
    super('invalid_team_template');
  }
}

export interface TeamTemplateBot {
  key: string;
  template: BotTemplate;
}

export interface TeamTemplateRole {
  botKey: string;
  role: string;
}

export interface TeamTemplateBudgets {
  maxDurationSeconds: number;
  maxTurns: number;
  maxDelegationDepth: number;
  maxHandoffs?: number;
}

export interface TeamTemplate {
  schemaVersion: typeof TEAM_TEMPLATE_SCHEMA_VERSION;
  identity: { name: string; description: string };
  bots: TeamTemplateBot[];
  roles: TeamTemplateRole[];
  defaultLead: { botKey: string } | null;
  collaboration: { maxConcurrentRuns: number };
  budgets: TeamTemplateBudgets;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function forbiddenFields(value: unknown, path = ''): TeamTemplateFieldError[] {
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

function botKey(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : undefined;
}

function roleName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.trim().length <= 200
    ? value.trim()
    : undefined;
}

export function parseTeamTemplate(input: unknown): TeamTemplate {
  const forbidden = forbiddenFields(input);
  if (forbidden.length) throw new TeamTemplateError(forbidden);
  if (!object(input)) throw new TeamTemplateError([{ field: '', code: 'malformed' }]);
  const errors: TeamTemplateFieldError[] = [];
  for (const key of Object.keys(input)) {
    if (!TEMPLATE_KEYS.includes(key as (typeof TEMPLATE_KEYS)[number]))
      errors.push({ field: key, code: 'unknown_field' });
  }
  if (input.schemaVersion !== TEAM_TEMPLATE_SCHEMA_VERSION)
    errors.push({ field: 'schemaVersion', code: 'unsupported_schema' });
  const identity = input.identity;
  if (
    !object(identity) ||
    Object.keys(identity).some((key) => !['name', 'description'].includes(key)) ||
    typeof identity.name !== 'string' ||
    !identity.name.trim() ||
    identity.name.trim().length > 100 ||
    typeof identity.description !== 'string' ||
    identity.description.length > 2000
  )
    errors.push({ field: 'identity', code: 'malformed' });
  if (!Array.isArray(input.bots) || input.bots.length === 0)
    errors.push({ field: 'bots', code: 'malformed' });
  const bots: TeamTemplateBot[] = [];
  const keys = new Set<string>();
  for (const [index, row] of (Array.isArray(input.bots) ? input.bots : []).entries()) {
    if (!object(row) || Object.keys(row).some((key) => !['key', 'template'].includes(key))) {
      errors.push({ field: `bots[${index}]`, code: 'malformed' });
      continue;
    }
    const key = botKey(row.key);
    if (!key || keys.has(key)) {
      errors.push({ field: `bots[${index}].key`, code: 'malformed' });
      continue;
    }
    keys.add(key);
    try {
      bots.push({ key, template: parseBotTemplate(row.template) });
    } catch (error) {
      if (error instanceof BotTemplateError)
        errors.push(
          ...error.fields.map((field) => ({
            field: `bots[${index}].template${field.field ? `.${field.field}` : ''}`,
            code: field.code,
          })),
        );
      else errors.push({ field: `bots[${index}].template`, code: 'malformed' });
    }
  }
  if (!Array.isArray(input.roles) || input.roles.length !== keys.size)
    errors.push({ field: 'roles', code: 'malformed' });
  const roles: TeamTemplateRole[] = [];
  const roleKeys = new Set<string>();
  for (const [index, row] of (Array.isArray(input.roles) ? input.roles : []).entries()) {
    if (!object(row) || Object.keys(row).some((key) => !['botKey', 'role'].includes(key))) {
      errors.push({ field: `roles[${index}]`, code: 'malformed' });
      continue;
    }
    const key = botKey(row.botKey);
    const role = roleName(row.role);
    if (!key || !keys.has(key) || roleKeys.has(key) || !role) {
      errors.push({ field: `roles[${index}]`, code: 'malformed' });
      continue;
    }
    roleKeys.add(key);
    roles.push({ botKey: key, role });
  }
  let defaultLead: { botKey: string } | null = null;
  if (input.defaultLead === null) defaultLead = null;
  else if (
    object(input.defaultLead) &&
    Object.keys(input.defaultLead).join(',') === 'botKey' &&
    botKey(input.defaultLead.botKey) &&
    keys.has(input.defaultLead.botKey as string)
  )
    defaultLead = { botKey: input.defaultLead.botKey as string };
  else errors.push({ field: 'defaultLead', code: 'malformed' });
  const collaboration = input.collaboration;
  if (
    !object(collaboration) ||
    Object.keys(collaboration).join(',') !== 'maxConcurrentRuns' ||
    typeof collaboration.maxConcurrentRuns !== 'number' ||
    !Number.isSafeInteger(collaboration.maxConcurrentRuns) ||
    collaboration.maxConcurrentRuns < 1
  )
    errors.push({ field: 'collaboration', code: 'malformed' });
  let budgets: TeamTemplateBudgets | undefined;
  try {
    if (
      !object(input.budgets) ||
      Object.keys(input.budgets).some(
        (key) => !BUDGET_KEYS.includes(key as (typeof BUDGET_KEYS)[number]),
      )
    )
      throw new Error('malformed');
    const parsed = parseExecutionPolicy(input.budgets);
    if (
      parsed.maxDurationSeconds === undefined ||
      parsed.maxTurns === undefined ||
      parsed.maxDelegationDepth === undefined
    )
      throw new Error('malformed');
    budgets = {
      maxDurationSeconds: parsed.maxDurationSeconds,
      maxTurns: parsed.maxTurns,
      maxDelegationDepth: parsed.maxDelegationDepth,
      ...(parsed.maxHandoffs !== undefined ? { maxHandoffs: parsed.maxHandoffs } : {}),
    };
  } catch {
    errors.push({ field: 'budgets', code: 'malformed' });
  }
  if (errors.length) throw new TeamTemplateError(errors);
  return {
    schemaVersion: TEAM_TEMPLATE_SCHEMA_VERSION,
    identity: {
      name: (identity as { name: string }).name.trim(),
      description: (identity as { description: string }).description.trim(),
    },
    bots,
    roles,
    defaultLead,
    collaboration: {
      maxConcurrentRuns: (collaboration as { maxConcurrentRuns: number }).maxConcurrentRuns,
    },
    budgets: budgets!,
  };
}

export function exportTeamTemplate(input: {
  identity: { name: string; description: string };
  bots: Array<{
    key: string;
    role: string;
    visibility: 'private' | 'workspace';
    configuration: BotConfiguration;
  }>;
  defaultLeadKey: string | null;
  collaboration: { maxConcurrentRuns: number };
  budgets: ExecutionLimitPolicy;
}): TeamTemplate {
  return parseTeamTemplate({
    schemaVersion: TEAM_TEMPLATE_SCHEMA_VERSION,
    identity: input.identity,
    bots: input.bots.map((bot) => ({
      key: bot.key,
      template: exportBotTemplate({
        configuration: bot.configuration,
        visibility: bot.visibility,
      }),
    })),
    roles: input.bots.map((bot) => ({ botKey: bot.key, role: bot.role })),
    defaultLead: input.defaultLeadKey ? { botKey: input.defaultLeadKey } : null,
    collaboration: input.collaboration,
    budgets: input.budgets,
  });
}
