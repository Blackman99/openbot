import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { admitBotModel } from '../bots/model-binding.js';
import { lockAuthorizedBot, lockBotWorkspace } from '../bots/postgres-bot-access.js';
import {
  BotAccessError,
  BotModelError,
  DEFAULT_BOT_LIMITS,
  type BotBinding,
  type BotConfiguration,
} from '../bots/service.js';
import { templateConfiguration, templateContainsSecrets } from '../bots/template.js';
import { appendBotJoined } from '../conversations/append-event.js';
import { openGroupMembershipConversation } from '../conversations/postgres-repository.js';
import { GroupBotAccessError, GroupBotConflictError } from '../group-bots/service.js';
import { readGroupBotGrants } from '../group-bots/postgres-repository.js';
import { parseExecutionPolicy } from '../tasks/execution-limits.js';
import { DEFAULT_GROUP_CONCURRENT_RUNS } from '../tasks/execution-concurrency.js';
import { lockAuthorizedGroup } from './postgres-group-access.js';
import type { Group } from './service.js';
import {
  describeTeamTemplate,
  exportTeamTemplate,
  parseTeamImportCommand,
  parseTeamTemplate,
  teamTemplateContainsSecrets,
  unresolvedTeamImportErrors,
  TeamTemplateError,
  type TeamTemplate,
  type TeamTemplatePreview,
} from './team-template.js';

export class TeamTemplateInputError extends Error {}

function slugKey(name: string, used: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 64) || 'bot';
  let key = base;
  let suffix = 2;
  while (used.has(key)) {
    const tail = `-${suffix}`;
    key = `${base.slice(0, Math.max(1, 64 - tail.length))}${tail}`;
    suffix += 1;
  }
  used.add(key);
  return key;
}

export class TeamTemplateService {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async transaction<T>(operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await operation(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async export(actorUserId: string, workspaceId: string, groupId: string): Promise<TeamTemplate> {
    return this.transaction(async (connection) => {
      const group = await lockAuthorizedGroup(
        connection,
        { actorId: actorUserId, workspaceId, groupId },
        'manage',
      );
      const grants = (
        await readGroupBotGrants(connection, { actorUserId, workspaceId, groupId })
      ).filter((grant) => !grant.closed);
      if (!grants.length) throw new TeamTemplateError([{ field: 'bots', code: 'malformed' }]);
      const used = new Set<string>();
      const bots = [];
      for (const grant of grants) {
        const bot = await lockAuthorizedBot(
          connection,
          { actorUserId, workspaceId, botId: grant.bot.id },
          'inspect',
        );
        if (bot.lifecycle_state === 'deleted') throw new BotAccessError();
        const template = exportTeamTemplate({
          identity: { name: group.name, description: group.description },
          bots: [
            {
              key: slugKey(bot.configuration.name, used),
              role: grant.bot.roleDescription,
              visibility: bot.visibility,
              configuration: bot.configuration,
            },
          ],
          defaultLeadKey: null,
          collaboration: { maxConcurrentRuns: DEFAULT_GROUP_CONCURRENT_RUNS },
          budgets: {
            maxDurationSeconds: DEFAULT_BOT_LIMITS.maxDurationSeconds,
            maxTurns: DEFAULT_BOT_LIMITS.maxTurns,
            maxDelegationDepth: DEFAULT_BOT_LIMITS.maxDelegationDepth,
          },
        });
        if (templateContainsSecrets(template.bots[0]!.template))
          throw new TeamTemplateError([{ field: '', code: 'forbidden_field' }]);
        bots.push({
          key: template.bots[0]!.key,
          role: grant.bot.roleDescription,
          visibility: bot.visibility,
          configuration: bot.configuration,
          botId: bot.id,
        });
      }
      const policy = parseExecutionPolicy(
        (
          await connection.query<{ execution_policy: unknown }>(
            'SELECT execution_policy FROM groups WHERE id=$1',
            [groupId],
          )
        ).rows[0]?.execution_policy,
      );
      const leadGrantId = (
        await connection.query<{ default_grant_id: string | null }>(
          'SELECT default_grant_id FROM group_routing_settings WHERE group_id=$1',
          [groupId],
        )
      ).rows[0]?.default_grant_id;
      const leadBotId = leadGrantId
        ? grants.find((grant) => grant.id === leadGrantId)?.bot.id
        : undefined;
      const exported = exportTeamTemplate({
        identity: { name: group.name, description: group.description },
        bots,
        defaultLeadKey: leadBotId
          ? (bots.find((bot) => bot.botId === leadBotId)?.key ?? null)
          : null,
        collaboration: {
          maxConcurrentRuns: policy.maxConcurrentRuns ?? DEFAULT_GROUP_CONCURRENT_RUNS,
        },
        budgets: {
          maxDurationSeconds: policy.maxDurationSeconds ?? DEFAULT_BOT_LIMITS.maxDurationSeconds,
          maxTurns: policy.maxTurns ?? DEFAULT_BOT_LIMITS.maxTurns,
          maxDelegationDepth: policy.maxDelegationDepth ?? DEFAULT_BOT_LIMITS.maxDelegationDepth,
          ...(policy.maxHandoffs !== undefined ? { maxHandoffs: policy.maxHandoffs } : {}),
        },
      });
      if (teamTemplateContainsSecrets(exported))
        throw new TeamTemplateError([{ field: '', code: 'forbidden_field' }]);
      return exported;
    });
  }

  async preview(
    actorUserId: string,
    workspaceId: string,
    input: unknown,
  ): Promise<TeamTemplatePreview> {
    const command = previewInput(input);
    const template = parseTeamTemplate(command.template);
    if (teamTemplateContainsSecrets(template))
      throw new TeamTemplateError([{ field: '', code: 'forbidden_field' }]);
    return this.transaction(async (connection) => {
      await lockBotWorkspace(connection, actorUserId, workspaceId);
      return describeTeamTemplate(template, {
        boundBotKeys: Object.keys(command.modelBindings),
        acceptedAcknowledgements: command.acknowledgements,
      });
    });
  }

  async import(
    actorUserId: string,
    workspaceId: string,
    input: unknown,
  ): Promise<{ group: Group; bots: Array<{ key: string; id: string }> }> {
    const command = parseTeamImportCommand(input);
    const unresolved = unresolvedTeamImportErrors(
      command.template,
      command.modelBindings,
      command.acknowledgements,
    );
    if (unresolved.length) throw new TeamTemplateError(unresolved);
    return this.transaction(async (connection) => {
      await lockBotWorkspace(connection, actorUserId, workspaceId);
      const createdBots: Array<{ key: string; id: string; grantId: string }> = [];
      for (const bot of command.template.bots) {
        const binding = command.modelBindings[bot.key]!;
        const configuration = templateConfiguration(bot.template, binding);
        let admitted;
        try {
          admitted = await admitBotModel(connection, actorUserId, workspaceId, binding);
        } catch (error) {
          if (error instanceof BotModelError)
            throw new TeamTemplateError([
              { field: `modelBindings.${bot.key}`, code: error.reason },
            ]);
          throw error;
        }
        if (bot.template.capabilities.required !== 'basic' && admitted.chatOnly)
          throw new TeamTemplateError([
            { field: `modelBindings.${bot.key}`, code: 'unmet_capability' },
          ]);
        const created = await insertImportedBot(connection, {
          actorUserId,
          workspaceId,
          configuration,
          now: this.now(),
        });
        createdBots.push({ key: bot.key, id: created.id, grantId: '' });
      }
      const groupId = randomUUID();
      const occurredAt = this.now();
      const executionPolicy = {
        maxConcurrentRuns: command.template.collaboration.maxConcurrentRuns,
        maxDurationSeconds: command.template.budgets.maxDurationSeconds,
        maxTurns: command.template.budgets.maxTurns,
        maxDelegationDepth: command.template.budgets.maxDelegationDepth,
        ...(command.template.budgets.maxHandoffs !== undefined
          ? { maxHandoffs: command.template.budgets.maxHandoffs }
          : {}),
      };
      await connection.query(
        'INSERT INTO groups (id,workspace_id,name,description,visibility,created_by_user_id,created_at,updated_at,execution_policy) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8::jsonb)',
        [
          groupId,
          workspaceId,
          command.template.identity.name,
          command.template.identity.description,
          'private',
          actorUserId,
          occurredAt,
          JSON.stringify(executionPolicy),
        ],
      );
      await connection.query(
        "INSERT INTO group_memberships (group_id,user_id,role,created_at) VALUES ($1,$2,'owner',$3)",
        [groupId, actorUserId, occurredAt],
      );
      await connection.query(
        "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'group.created',$2,$3,$4::jsonb)",
        [
          randomUUID(),
          actorUserId,
          occurredAt,
          JSON.stringify({ groupId, workspaceId, visibility: 'private', origin: 'team-template' }),
        ],
      );
      for (const created of createdBots) {
        const grant = await inviteImportedBot(connection, {
          actorUserId,
          workspaceId,
          groupId,
          botId: created.id,
          idempotencyKey: `team-template:${created.key}`,
          now: this.now,
        });
        created.grantId = grant.id;
      }
      const leadKey = command.template.defaultLead?.botKey;
      if (leadKey) {
        const lead = createdBots.find((bot) => bot.key === leadKey);
        if (!lead) throw new TeamTemplateError([{ field: 'defaultLead', code: 'malformed' }]);
        await connection.query(
          'INSERT INTO group_routing_settings(group_id,workspace_id,default_grant_id,revision,updated_by_user_id,updated_at) VALUES($1,$2,$3,1,$4,$5)',
          [groupId, workspaceId, lead.grantId, actorUserId, occurredAt],
        );
      }
      for (const routine of command.template.routines ?? []) {
        await connection.query(
          'INSERT INTO group_imported_routines(id,workspace_id,group_id,routine_key,name,enabled,created_at) VALUES($1,$2,$3,$4,$5,false,$6)',
          [randomUUID(), workspaceId, groupId, routine.key, routine.name, occurredAt],
        );
      }
      return {
        group: {
          id: groupId,
          workspaceId,
          name: command.template.identity.name,
          description: command.template.identity.description,
          visibility: 'private',
          role: 'owner',
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
        bots: createdBots.map((bot) => ({ key: bot.key, id: bot.id })),
      };
    });
  }
}

function previewInput(input: unknown): {
  template: unknown;
  modelBindings: Record<string, BotBinding>;
  acknowledgements: string[];
} {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('template' in input))
    throw new TeamTemplateInputError();
  const extra = Object.keys(input).filter(
    (key) => key !== 'template' && key !== 'modelBindings' && key !== 'acknowledgements',
  );
  if (extra.length) throw new TeamTemplateInputError();
  if ('modelBindings' in input && input.modelBindings !== undefined) {
    const parsed = parseTeamImportCommand({
      template: (input as { template: unknown }).template,
      modelBindings: (input as { modelBindings: unknown }).modelBindings,
      acknowledgements: (input as { acknowledgements?: unknown }).acknowledgements ?? [],
    });
    return {
      template: parsed.template,
      modelBindings: parsed.modelBindings,
      acknowledgements: parsed.acknowledgements,
    };
  }
  const acknowledgements = 'acknowledgements' in input ? input.acknowledgements : [];
  return {
    template: input.template,
    modelBindings: {},
    acknowledgements: Array.isArray(acknowledgements)
      ? acknowledgements.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

async function insertImportedBot(
  connection: SqlConnection,
  input: {
    actorUserId: string;
    workspaceId: string;
    configuration: BotConfiguration;
    now: Date;
  },
) {
  const id = randomUUID();
  const versionId = randomUUID();
  await connection.query(
    "INSERT INTO bots(id,workspace_id,current_version_id,visibility,created_by_user_id,created_at) VALUES($1,$2,$3,'private',$4,$5)",
    [id, input.workspaceId, versionId, input.actorUserId, input.now],
  );
  await connection.query(
    "INSERT INTO bot_versions(id,bot_id,version,configuration,author_user_id,created_at,rationale) VALUES($1,$2,1,$3::jsonb,$4,$5,'Imported team template')",
    [versionId, id, JSON.stringify(input.configuration), input.actorUserId, input.now],
  );
  await connection.query(
    "INSERT INTO bot_acl(bot_id,user_id,role,created_at) VALUES($1,$2,'owner',$3)",
    [id, input.actorUserId, input.now],
  );
  await connection.query(
    "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'bot.created',$2,$3,$4::jsonb)",
    [
      randomUUID(),
      input.actorUserId,
      input.now,
      JSON.stringify({
        botId: id,
        workspaceId: input.workspaceId,
        versionId,
        version: 1,
        origin: 'team-template',
      }),
    ],
  );
  return { id, versionId };
}

async function inviteImportedBot(
  connection: SqlConnection,
  input: {
    actorUserId: string;
    workspaceId: string;
    groupId: string;
    botId: string;
    idempotencyKey: string;
    now: () => Date;
  },
) {
  await lockAuthorizedGroup(
    connection,
    { actorId: input.actorUserId, workspaceId: input.workspaceId, groupId: input.groupId },
    'manage',
  );
  await lockAuthorizedBot(
    connection,
    { actorUserId: input.actorUserId, workspaceId: input.workspaceId, botId: input.botId },
    'use',
  );
  const conversation = await openGroupMembershipConversation(
    connection,
    input.actorUserId,
    input.workspaceId,
    input.groupId,
    input.now,
  );
  const history = { mode: 'future-only' as const };
  const hash = createHash('sha256')
    .update(JSON.stringify({ type: 'bot.joined', botId: input.botId, history }))
    .digest('hex');
  const active = (
    await connection.query<{ bot_id: string }>(
      'SELECT bot_id FROM group_bot_grants WHERE workspace_id=$1 AND group_id=$2 AND close_event_id IS NULL',
      [input.workspaceId, input.groupId],
    )
  ).rows;
  if (active.some((grant) => grant.bot_id === input.botId))
    throw new GroupBotConflictError('group_bot_already_active');
  if (active.length >= 8) throw new GroupBotConflictError('group_bot_limit');
  const grantId = randomUUID();
  const receipt = await appendBotJoined(
    connection,
    {
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      conversationId: conversation.id,
    },
    {
      idempotencyKey: input.idempotencyKey,
      hash,
      groupId: input.groupId,
      botId: input.botId,
      grantId,
      history,
      lowerBound: null,
    },
    input.now,
  );
  await connection.query(
    'INSERT INTO group_bot_grants(id,workspace_id,group_id,bot_id,conversation_id,granted_by_user_id,history_mode,lower_bound,join_event_id,join_sequence,joined_at,source_event_id,source_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [
      grantId,
      input.workspaceId,
      input.groupId,
      input.botId,
      conversation.id,
      input.actorUserId,
      history.mode,
      receipt.sequence,
      receipt.eventId,
      receipt.sequence,
      receipt.occurredAt,
      null,
      null,
    ],
  );
  const grant = (
    await readGroupBotGrants(connection, {
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      groupId: input.groupId,
    })
  ).find((row) => row.id === grantId);
  if (!grant) throw new GroupBotAccessError();
  return grant;
}
