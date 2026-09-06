import { describe, expect, it } from 'vitest';
import {
  TEAM_TEMPLATE_SCHEMA_VERSION,
  TeamTemplateError,
  exportTeamTemplate,
  parseTeamTemplate,
} from '../../src/groups/team-template.js';
import { BOT_TEMPLATE_SCHEMA_VERSION } from '../../src/bots/template.js';
import { DEFAULT_BOT_LIMITS } from '../../src/bots/service.js';
import { DEFAULT_GROUP_CONCURRENT_RUNS } from '../../src/tasks/execution-concurrency.js';

const researcher = {
  key: 'researcher',
  role: 'Researcher',
  visibility: 'workspace' as const,
  configuration: {
    name: 'Researcher',
    roleDescription: 'Researcher',
    description: 'Finds sources',
    instructions: 'Cite every claim.',
    modelBinding: {
      scope: { kind: 'personal' as const, id: '11111111-1111-4111-8111-111111111111' },
      connectionId: '22222222-2222-4222-8222-222222222222',
      modelId: 'secret-model',
    },
    limits: DEFAULT_BOT_LIMITS,
    avatarObjectId: '33333333-3333-4333-8333-333333333333',
  },
};

const writer = {
  key: 'writer',
  role: 'Writer',
  visibility: 'private' as const,
  configuration: {
    name: 'Writer',
    roleDescription: 'Writer',
    description: 'Drafts answers',
    instructions: 'Write from the research notes.',
    modelBinding: {
      scope: { kind: 'workspace' as const, id: '44444444-4444-4444-8444-444444444444' },
      connectionId: '55555555-5555-4555-8555-555555555555',
      modelId: 'other-secret-model',
    },
    limits: DEFAULT_BOT_LIMITS,
  },
};

function fields(input: unknown) {
  try {
    parseTeamTemplate(input);
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(TeamTemplateError);
    return (error as TeamTemplateError).fields;
  }
}

describe('safe Bot-team template schema', () => {
  it('exports Bot templates, group roles, default Lead, collaboration limits and budgets without users or secrets', () => {
    const template = exportTeamTemplate({
      identity: { name: 'Research desk', description: 'Find then write' },
      bots: [researcher, writer],
      defaultLeadKey: 'researcher',
      collaboration: { maxConcurrentRuns: DEFAULT_GROUP_CONCURRENT_RUNS },
      budgets: {
        maxDurationSeconds: 300,
        maxTurns: 8,
        maxDelegationDepth: 2,
      },
    });
    expect(template).toEqual({
      schemaVersion: TEAM_TEMPLATE_SCHEMA_VERSION,
      identity: { name: 'Research desk', description: 'Find then write' },
      bots: [
        {
          key: 'researcher',
          template: {
            schemaVersion: BOT_TEMPLATE_SCHEMA_VERSION,
            identity: {
              name: 'Researcher',
              roleDescription: 'Researcher',
              description: 'Finds sources',
            },
            instructions: 'Cite every claim.',
            capabilities: { required: 'basic' },
            collaboration: { visibility: 'workspace' },
            budgets: DEFAULT_BOT_LIMITS,
          },
        },
        {
          key: 'writer',
          template: {
            schemaVersion: BOT_TEMPLATE_SCHEMA_VERSION,
            identity: { name: 'Writer', roleDescription: 'Writer', description: 'Drafts answers' },
            instructions: 'Write from the research notes.',
            capabilities: { required: 'basic' },
            collaboration: { visibility: 'private' },
            budgets: DEFAULT_BOT_LIMITS,
          },
        },
      ],
      roles: [
        { botKey: 'researcher', role: 'Researcher' },
        { botKey: 'writer', role: 'Writer' },
      ],
      defaultLead: { botKey: 'researcher' },
      collaboration: { maxConcurrentRuns: 4 },
      budgets: { maxDurationSeconds: 300, maxTurns: 8, maxDelegationDepth: 2 },
    });
    const serialized = JSON.stringify(template);
    expect(serialized).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(serialized).not.toContain('22222222-2222-4222-8222-222222222222');
    expect(serialized).not.toContain('33333333-3333-4333-8333-333333333333');
    expect(serialized).not.toContain('44444444-4444-4444-8444-444444444444');
    expect(serialized).not.toContain('55555555-5555-4555-8555-555555555555');
    expect(serialized).not.toMatch(
      /"connectionId"|"avatarObjectId"|"headers"|"apiKey"|"userId"|"grantId"|"email"|"history"|"memory"|"fileBody"/,
    );
  });

  it('rejects users, secrets, histories, memories and file bodies with field errors', () => {
    const valid = exportTeamTemplate({
      identity: { name: 'Research desk', description: 'Find then write' },
      bots: [researcher],
      defaultLeadKey: 'researcher',
      collaboration: { maxConcurrentRuns: 4 },
      budgets: { maxDurationSeconds: 300, maxTurns: 8, maxDelegationDepth: 2 },
    });
    expect(fields({ ...valid, members: [{ userId: 'aaaa', email: 'owner@example.com' }] })).toEqual(
      [
        { field: 'members', code: 'forbidden_field' },
        { field: 'members[0].userId', code: 'forbidden_field' },
        { field: 'members[0].email', code: 'forbidden_field' },
      ],
    );
    expect(fields({ ...valid, userId: '11111111-1111-4111-8111-111111111111' })).toEqual([
      { field: 'userId', code: 'forbidden_field' },
    ]);
    expect(fields({ ...valid, grantId: '66666666-6666-4666-8666-666666666666' })).toEqual([
      { field: 'grantId', code: 'forbidden_field' },
    ]);
    expect(fields({ ...valid, history: [{ body: 'prior chat' }] })).toEqual([
      { field: 'history', code: 'forbidden_field' },
    ]);
    expect(fields({ ...valid, memories: [{ text: 'secret fact' }] })).toEqual([
      { field: 'memories', code: 'forbidden_field' },
    ]);
    expect(fields({ ...valid, fileBody: 'bytes' })).toEqual([
      { field: 'fileBody', code: 'forbidden_field' },
    ]);
    expect(
      fields({
        ...valid,
        bots: [{ ...valid.bots[0], template: { ...valid.bots[0]!.template, connectionId: 'x' } }],
      }),
    ).toEqual([{ field: 'bots[0].template.connectionId', code: 'forbidden_field' }]);
  });
});
