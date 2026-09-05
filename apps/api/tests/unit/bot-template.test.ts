import { describe, expect, it } from 'vitest';
import {
  BOT_TEMPLATE_SCHEMA_VERSION,
  BotTemplateError,
  exportBotTemplate,
  parseBotTemplate,
  templateContainsSecrets,
  templateConfiguration,
  templateDifferences,
} from '../../src/bots/template.js';
import { DEFAULT_BOT_LIMITS } from '../../src/bots/service.js';

const valid = {
  schemaVersion: BOT_TEMPLATE_SCHEMA_VERSION,
  identity: { name: 'Helper', roleDescription: 'Researcher', description: 'Notes' },
  instructions: 'Answer with cited sources.',
  capabilities: { required: 'basic' },
  collaboration: { visibility: 'private' },
  budgets: DEFAULT_BOT_LIMITS,
};

function fields(input: unknown) {
  try {
    parseBotTemplate(input);
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(BotTemplateError);
    return (error as BotTemplateError).fields;
  }
}

describe('safe Bot template schema', () => {
  it('exports identity, instructions, capabilities, collaboration policy and budgets without secrets', () => {
    const template = exportBotTemplate({
      visibility: 'workspace',
      configuration: {
        name: 'Helper',
        roleDescription: 'Researcher',
        description: 'Notes',
        instructions: 'Never send an apiKey or connectionId in user text.',
        modelBinding: {
          scope: { kind: 'personal', id: '11111111-1111-4111-8111-111111111111' },
          connectionId: '22222222-2222-4222-8222-222222222222',
          modelId: 'secret-model',
        },
        limits: DEFAULT_BOT_LIMITS,
        avatarObjectId: '33333333-3333-4333-8333-333333333333',
      },
    });
    expect(template).toEqual({
      schemaVersion: BOT_TEMPLATE_SCHEMA_VERSION,
      identity: { name: 'Helper', roleDescription: 'Researcher', description: 'Notes' },
      instructions: 'Never send an apiKey or connectionId in user text.',
      capabilities: { required: 'basic' },
      collaboration: { visibility: 'workspace' },
      budgets: DEFAULT_BOT_LIMITS,
    });
    const serialized = JSON.stringify(template);
    expect(serialized).not.toContain('22222222-2222-4222-8222-222222222222');
    expect(serialized).not.toContain('33333333-3333-4333-8333-333333333333');
    expect(serialized).not.toMatch(/"connectionId"|"avatarObjectId"|"headers"|"apiKey"/);
    expect(templateContainsSecrets(template)).toBe(false);
  });

  it('rejects unsupported versions, forbidden fields and malformed values with field errors', () => {
    expect(fields({ ...valid, schemaVersion: 'openbot.bot-template.v0' })).toEqual([
      { field: 'schemaVersion', code: 'unsupported_schema' },
    ]);
    expect(fields({ ...valid, connectionId: '22222222-2222-4222-8222-222222222222' })).toEqual([
      { field: 'connectionId', code: 'forbidden_field' },
    ]);
    expect(fields({ ...valid, headers: { Authorization: 'secret' } })).toEqual([
      { field: 'headers', code: 'forbidden_field' },
    ]);
    expect(fields({ ...valid, privateMemory: { text: 'secret fact' } })).toEqual([
      { field: 'privateMemory', code: 'forbidden_field' },
    ]);
    expect(fields({ ...valid, conversationHistory: [{ role: 'user', text: 'hi' }] })).toEqual([
      { field: 'conversationHistory', code: 'forbidden_field' },
    ]);
    expect(fields({ ...valid, attachment: { body: 'file-bytes' } })).toEqual([
      { field: 'attachment', code: 'forbidden_field' },
    ]);
    expect(fields({ ...valid, sourceWorkspaceId: '11111111-1111-4111-8111-111111111111' })).toEqual(
      [{ field: 'sourceWorkspaceId', code: 'forbidden_field' }],
    );
    expect(fields({ ...valid, extra: true })).toEqual([{ field: 'extra', code: 'unknown_field' }]);
    expect(
      fields({ ...valid, identity: { name: '', roleDescription: 'x', description: '' } }),
    ).toEqual([{ field: 'identity', code: 'malformed' }]);
    expect(fields({ ...valid, budgets: { maxTurns: 0 } })).toEqual([
      { field: 'budgets', code: 'malformed' },
    ]);
  });

  it('binds an import to an explicit model without copying source connection IDs', () => {
    const configuration = templateConfiguration(parseBotTemplate(valid), {
      scope: { kind: 'personal', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      modelId: 'local-model',
    });
    expect(configuration.modelBinding.connectionId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(configuration.instructions).toBe('Answer with cited sources.');
    expect(
      templateDifferences(parseBotTemplate(valid), {
        ...configuration,
        name: 'Other',
        instructions: 'Different instructions.',
      }),
    ).toEqual([
      { field: 'identity.name', template: 'Helper', local: 'Other' },
      {
        field: 'instructions',
        template: 'Answer with cited sources.',
        local: 'Different instructions.',
      },
    ]);
  });
});
