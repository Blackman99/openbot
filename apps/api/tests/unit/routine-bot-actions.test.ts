import { describe, expect, it } from 'vitest';
import {
  botRoutineCollaborationDenial,
  parseCreateRoutineAction,
  parseEditRoutineAction,
} from '../../src/routines/bot-actions.js';

const routineId = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';

describe('ROUT-01 bot collaboration routine deny', () => {
  it('recognizes create_routine collaboration actions', () => {
    expect(
      parseCreateRoutineAction({
        type: 'action',
        id: 'call-1',
        name: 'create_routine',
        arguments: {
          groupId,
          prompt: 'Run the digest.',
          timeZone: 'UTC',
          executeAt: '2026-09-07T01:00:00.000Z',
          expiresAt: '2026-09-08T01:00:00.000Z',
          maxCostMicros: 1_000_000,
        },
      }),
    ).toMatchObject({
      groupId,
      prompt: 'Run the digest.',
      maxCostMicros: 1_000_000,
    });
  });

  it('recognizes edit_routine escalation of budget or frequency', () => {
    expect(
      parseEditRoutineAction({
        type: 'action',
        id: 'call-2',
        name: 'edit_routine',
        arguments: { routineId, maxCostMicros: 5_000_000 },
      }),
    ).toMatchObject({ routineId, maxCostMicros: 5_000_000 });
    expect(
      parseEditRoutineAction({
        type: 'action',
        id: 'call-3',
        name: 'edit_routine',
        arguments: { routineId, cron: '0 * * * *' },
      }),
    ).toMatchObject({ routineId, cron: '0 * * * *' });
  });

  it('denies bot create and budget/frequency escalation actions', () => {
    expect(
      botRoutineCollaborationDenial({
        type: 'action',
        id: 'call-1',
        name: 'create_routine',
        arguments: {
          groupId,
          prompt: 'Run the digest.',
          timeZone: 'UTC',
          executeAt: '2026-09-07T01:00:00.000Z',
          expiresAt: '2026-09-08T01:00:00.000Z',
          maxCostMicros: 1_000_000,
        },
      }),
    ).toBe('create');
    expect(
      botRoutineCollaborationDenial({
        type: 'action',
        id: 'call-2',
        name: 'edit_routine',
        arguments: { routineId, maxCostMicros: 5_000_000 },
      }),
    ).toBe('escalate');
    expect(
      botRoutineCollaborationDenial({
        type: 'action',
        id: 'call-3',
        name: 'edit_routine',
        arguments: { routineId, cron: '*/5 * * * *' },
      }),
    ).toBe('escalate');
    expect(
      botRoutineCollaborationDenial({
        type: 'action',
        id: 'call-4',
        name: 'edit_routine',
        arguments: { routineId, frequency: 'hourly' },
      }),
    ).toBe('escalate');
    expect(
      botRoutineCollaborationDenial({
        type: 'action',
        id: 'call-5',
        name: 'delegate',
        arguments: { grantId: routineId, body: 'ok' },
      }),
    ).toBeUndefined();
  });
});
