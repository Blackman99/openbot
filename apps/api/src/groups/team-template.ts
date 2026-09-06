import {
  BotTemplateError,
  exportBotTemplate,
  parseBotTemplate,
  parseImportBinding,
  type BotTemplate,
} from '../bots/template.js';
import type { BotBinding, BotConfiguration } from '../bots/service.js';
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

export const TEAM_TEMPLATE_COMPATIBLE_SCHEMA_VERSIONS = [
  TEAM_TEMPLATE_SCHEMA_VERSION,
  'openbot.team-template.v1.routines',
] as const;

export const TEAM_TEMPLATE_ACKNOWLEDGEMENTS = [
  'create-bots',
  'create-memberships',
  'create-group-configuration',
  'no-source-access',
] as const;

export const TEAM_TEMPLATE_ROUTINE_ACKNOWLEDGEMENT = 'routines-remain-disabled';

const TEMPLATE_KEYS = [
  'schemaVersion',
  'identity',
  'bots',
  'roles',
  'defaultLead',
  'collaboration',
  'budgets',
  'routines',
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

export interface TeamTemplateRoutine {
  key: string;
  name: string;
}

export interface TeamTemplate {
  schemaVersion: typeof TEAM_TEMPLATE_SCHEMA_VERSION;
  identity: { name: string; description: string };
  bots: TeamTemplateBot[];
  roles: TeamTemplateRole[];
  defaultLead: { botKey: string } | null;
  collaboration: { maxConcurrentRuns: number };
  budgets: TeamTemplateBudgets;
  routines?: TeamTemplateRoutine[];
}

export type TeamTemplateObject =
  | { kind: 'group'; name: string; description: string }
  | { kind: 'bot'; key: string; name: string; role: string; requiredCapability: string }
  | { kind: 'membership'; botKey: string; role: string }
  | { kind: 'collaboration'; maxConcurrentRuns: number }
  | {
      kind: 'budgets';
      maxDurationSeconds: number;
      maxTurns: number;
      maxDelegationDepth: number;
      maxHandoffs?: number;
    }
  | { kind: 'defaultLead'; botKey: string | null }
  | { kind: 'routine'; key: string; name: string; enabled: false };

export interface TeamTemplatePreview {
  template: TeamTemplate;
  objects: TeamTemplateObject[];
  mappings: Array<{ botKey: string; requiredCapability: string; bound: boolean }>;
  acknowledgements: Array<{ id: string; required: true; accepted: boolean }>;
  unresolved: boolean;
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
  if (
    !TEAM_TEMPLATE_COMPATIBLE_SCHEMA_VERSIONS.includes(
      input.schemaVersion as (typeof TEAM_TEMPLATE_COMPATIBLE_SCHEMA_VERSIONS)[number],
    )
  )
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
  const routines: TeamTemplateRoutine[] = [];
  const routineKeys = new Set<string>();
  if (input.routines !== undefined) {
    if (!Array.isArray(input.routines)) errors.push({ field: 'routines', code: 'malformed' });
    for (const [index, row] of (Array.isArray(input.routines) ? input.routines : []).entries()) {
      if (!object(row) || Object.keys(row).some((key) => !['key', 'name'].includes(key))) {
        errors.push({ field: `routines[${index}]`, code: 'malformed' });
        continue;
      }
      const key = botKey(row.key);
      const name =
        typeof row.name === 'string' && row.name.trim() && row.name.trim().length <= 200
          ? row.name.trim()
          : undefined;
      if (!key || routineKeys.has(key) || !name) {
        errors.push({ field: `routines[${index}]`, code: 'malformed' });
        continue;
      }
      routineKeys.add(key);
      routines.push({ key, name });
    }
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
    ...(routines.length ? { routines } : {}),
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
  routines?: TeamTemplateRoutine[];
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
    ...(input.routines?.length ? { routines: input.routines } : {}),
  });
}

export function teamTemplateAcknowledgements(template: TeamTemplate): string[] {
  return [
    ...TEAM_TEMPLATE_ACKNOWLEDGEMENTS,
    ...(template.routines?.length ? [TEAM_TEMPLATE_ROUTINE_ACKNOWLEDGEMENT] : []),
  ];
}

export function describeTeamTemplate(
  template: TeamTemplate,
  input: { boundBotKeys?: Iterable<string>; acceptedAcknowledgements?: Iterable<string> } = {},
): TeamTemplatePreview {
  const bound = new Set(input.boundBotKeys);
  const accepted = new Set(input.acceptedAcknowledgements);
  const roleByKey = new Map(template.roles.map((role) => [role.botKey, role.role]));
  const objects: TeamTemplateObject[] = [
    { kind: 'group', name: template.identity.name, description: template.identity.description },
    ...template.bots.map((bot) => ({
      kind: 'bot' as const,
      key: bot.key,
      name: bot.template.identity.name,
      role: roleByKey.get(bot.key) ?? bot.template.identity.roleDescription,
      requiredCapability: bot.template.capabilities.required,
    })),
    ...template.roles.map((role) => ({
      kind: 'membership' as const,
      botKey: role.botKey,
      role: role.role,
    })),
    { kind: 'collaboration', maxConcurrentRuns: template.collaboration.maxConcurrentRuns },
    {
      kind: 'budgets',
      maxDurationSeconds: template.budgets.maxDurationSeconds,
      maxTurns: template.budgets.maxTurns,
      maxDelegationDepth: template.budgets.maxDelegationDepth,
      ...(template.budgets.maxHandoffs !== undefined
        ? { maxHandoffs: template.budgets.maxHandoffs }
        : {}),
    },
    { kind: 'defaultLead', botKey: template.defaultLead?.botKey ?? null },
    ...(template.routines ?? []).map((routine) => ({
      kind: 'routine' as const,
      key: routine.key,
      name: routine.name,
      enabled: false as const,
    })),
  ];
  const mappings = template.bots.map((bot) => ({
    botKey: bot.key,
    requiredCapability: bot.template.capabilities.required,
    bound: bound.has(bot.key),
  }));
  const acknowledgements = teamTemplateAcknowledgements(template).map((id) => ({
    id,
    required: true as const,
    accepted: accepted.has(id),
  }));
  return {
    template,
    objects,
    mappings,
    acknowledgements,
    unresolved:
      mappings.some((mapping) => !mapping.bound) ||
      acknowledgements.some((acknowledgement) => !acknowledgement.accepted),
  };
}

export function teamTemplateContainsSecrets(template: TeamTemplate): boolean {
  return forbiddenFields(template).length > 0;
}

export function parseTeamImportCommand(input: unknown): {
  template: TeamTemplate;
  modelBindings: Record<string, BotBinding>;
  acknowledgements: string[];
} {
  if (!object(input) || !('template' in input))
    throw new TeamTemplateError([{ field: '', code: 'malformed' }]);
  const extra = Object.keys(input).filter(
    (key) => key !== 'template' && key !== 'modelBindings' && key !== 'acknowledgements',
  );
  if (extra.length)
    throw new TeamTemplateError(extra.map((field) => ({ field, code: 'unknown_field' })));
  const template = parseTeamTemplate(input.template);
  if (teamTemplateContainsSecrets(template))
    throw new TeamTemplateError([{ field: '', code: 'forbidden_field' }]);
  const bindings: Record<string, BotBinding> = {};
  if (input.modelBindings !== undefined) {
    if (!object(input.modelBindings))
      throw new TeamTemplateError([{ field: 'modelBindings', code: 'malformed' }]);
    for (const [key, value] of Object.entries(input.modelBindings)) {
      if (!botKey(key) || !template.bots.some((bot) => bot.key === key))
        throw new TeamTemplateError([{ field: `modelBindings.${key}`, code: 'malformed' }]);
      try {
        bindings[key] = parseImportBinding(value);
      } catch {
        throw new TeamTemplateError([{ field: `modelBindings.${key}`, code: 'malformed' }]);
      }
    }
  }
  if (input.acknowledgements !== undefined && !Array.isArray(input.acknowledgements))
    throw new TeamTemplateError([{ field: 'acknowledgements', code: 'malformed' }]);
  const acknowledgements = Array.isArray(input.acknowledgements)
    ? input.acknowledgements.filter((item): item is string => typeof item === 'string')
    : [];
  return { template, modelBindings: bindings, acknowledgements };
}

export function unresolvedTeamImportErrors(
  template: TeamTemplate,
  modelBindings: Record<string, BotBinding>,
  acknowledgements: readonly string[],
): TeamTemplateFieldError[] {
  const accepted = new Set(acknowledgements);
  return [
    ...template.bots
      .filter((bot) => !modelBindings[bot.key])
      .map((bot) => ({ field: `modelBindings.${bot.key}`, code: 'unresolved_mapping' })),
    ...teamTemplateAcknowledgements(template)
      .filter((id) => !accepted.has(id))
      .map((id) => ({ field: `acknowledgements.${id}`, code: 'unresolved_acknowledgement' })),
  ];
}
