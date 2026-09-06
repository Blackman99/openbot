import type { SqlPool } from '../auth/postgres-auth-repository.js';
import { lockAuthorizedBot, lockBotWorkspace } from './postgres-bot-access.js';
import {
  BotAccessError,
  BotInputError,
  BotModelError,
  type BotBinding,
  type BotDetail,
  type BotService,
} from './service.js';
import { admitBotModel } from './model-binding.js';
import {
  BotTemplateError,
  exportBotTemplate,
  parseBotTemplate,
  parseImportBinding,
  templateConfiguration,
  templateContainsSecrets,
  templateDifferences,
  type BotTemplate,
  type BotTemplateDifference,
} from './template.js';

export class BotTemplateService {
  constructor(
    private readonly pool: SqlPool,
    private readonly bots: BotService,
  ) {}

  async export(actorUserId: string, workspaceId: string, botId: string): Promise<BotTemplate> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const bot = await lockAuthorizedBot(
        connection,
        { actorUserId, workspaceId, botId },
        'inspect',
      );
      if (bot.lifecycle_state === 'deleted') throw new BotAccessError();
      const template = exportBotTemplate({
        configuration: bot.configuration,
        visibility: bot.visibility,
      });
      if (templateContainsSecrets(template))
        throw new BotTemplateError([{ field: '', code: 'forbidden_field' }]);
      await connection.query('COMMIT');
      return template;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async preview(
    actorUserId: string,
    workspaceId: string,
    input: unknown,
  ): Promise<{
    template: BotTemplate;
    differences: BotTemplateDifference[];
  }> {
    const command = previewInput(input);
    const template = parseBotTemplate(command.template);
    if (templateContainsSecrets(template))
      throw new BotTemplateError([{ field: '', code: 'forbidden_field' }]);
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await lockBotWorkspace(connection, actorUserId, workspaceId);
      let differences: BotTemplateDifference[] = [];
      if (command.compareBotId) {
        const local = await lockAuthorizedBot(
          connection,
          { actorUserId, workspaceId, botId: command.compareBotId },
          'inspect',
        );
        differences = templateDifferences(template, local.configuration);
      }
      await connection.query('COMMIT');
      return { template, differences };
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async import(actorUserId: string, workspaceId: string, input: unknown): Promise<BotDetail> {
    const command = importInput(input);
    const template = parseBotTemplate(command.template);
    if (templateContainsSecrets(template))
      throw new BotTemplateError([{ field: '', code: 'forbidden_field' }]);
    const configuration = templateConfiguration(template, command.modelBinding);
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await lockBotWorkspace(connection, actorUserId, workspaceId);
      const admitted = await admitBotModel(
        connection,
        actorUserId,
        workspaceId,
        configuration.modelBinding,
      );
      if (template.capabilities.required !== 'basic' && admitted.chatOnly)
        throw new BotTemplateError([{ field: 'capabilities.required', code: 'unmet_capability' }]);
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      if (error instanceof BotModelError)
        throw new BotTemplateError([{ field: 'modelBinding', code: error.reason }]);
      throw error;
    } finally {
      connection.release();
    }
    const created = await this.bots.create(actorUserId, workspaceId, configuration);
    if (
      created.currentVersion?.configuration.modelBinding.connectionId !==
      configuration.modelBinding.connectionId
    )
      throw new BotAccessError();
    return created;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function previewInput(input: unknown): { template: unknown; compareBotId?: string } {
  if (!object(input) || !('template' in input)) throw new BotInputError();
  const extra = Object.keys(input).filter((key) => key !== 'template' && key !== 'compareBotId');
  if (extra.length) throw new BotInputError();
  if (input.compareBotId !== undefined && typeof input.compareBotId !== 'string')
    throw new BotInputError();
  return {
    template: input.template,
    ...(typeof input.compareBotId === 'string' ? { compareBotId: input.compareBotId } : {}),
  };
}

function importInput(input: unknown): { template: unknown; modelBinding: BotBinding } {
  if (!object(input) || Object.keys(input).sort().join(',') !== 'modelBinding,template')
    throw new BotInputError();
  return { template: input.template, modelBinding: parseImportBinding(input.modelBinding) };
}
