import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import RoutinesPage from '../../src/routes/app/workspaces/[workspaceId]/groups/[groupId]/routines/+page.svelte';
import RoutinePage from '../../src/routes/app/workspaces/[workspaceId]/groups/[groupId]/routines/[routineId]/+page.svelte';
import type { Routine } from '../../src/lib/server/routine-api.js';

const user = { id: 'ada', email: 'ada@example.com', displayName: 'Ada' };
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Team',
  description: '',
  role: 'owner' as const,
};
const group = {
  id: '22222222-2222-4222-8222-222222222222',
  workspaceId: workspace.id,
  name: 'Research',
  description: '',
  visibility: 'private' as const,
  role: 'owner' as const,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};
const routine: Routine = {
  id: '33333333-3333-4333-8333-333333333333',
  workspaceId: workspace.id,
  groupId: group.id,
  ownerUserId: '44444444-4444-4444-8444-444444444444',
  prompt: 'Prepare the Monday brief.',
  routingPolicy: 'group',
  leadGrantId: null,
  timeZone: 'UTC',
  executeAt: '2026-09-07T01:00:00.000Z',
  expiresAt: '2026-09-08T01:00:00.000Z',
  maxCostMicros: 1_000_000,
  kind: 'one_time',
  status: 'active',
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
  taskId: null,
  conversationId: null,
};
const base = { user, workspace, workspaces: [workspace], group, grants: [] };

describe('routine pages', () => {
  it('lists routines and offers create controls', () => {
    const html = render(RoutinesPage, {
      props: {
        data: { ...base, routines: [routine] },
        form: null,
        params: { workspaceId: workspace.id, groupId: group.id },
      },
    }).body;
    expect(html).toContain('One-time routines');
    expect(html).toContain('Prepare the Monday brief.');
    expect(html).toContain('method="POST" action="?/create"');
    expect(html).toContain('Bots cannot create or escalate routines');
    expect(html).toContain(
      `href="/app/workspaces/${workspace.id}/groups/${group.id}/routines/${routine.id}"`,
    );
  });

  it('offers edit, pause, cancel, and linked task controls on the detail page', () => {
    const html = render(RoutinePage, {
      props: {
        data: {
          ...base,
          routine: {
            ...routine,
            taskId: '55555555-5555-4555-8555-555555555555',
            conversationId: '66666666-6666-4666-8666-666666666666',
          },
        },
        form: null,
        params: { workspaceId: workspace.id, groupId: group.id, routineId: routine.id },
      },
    }).body;
    expect(html).toContain('Edit routine');
    expect(html).toContain('method="POST" action="?/edit"');
    expect(html).toContain('method="POST" action="?/pause"');
    expect(html).toContain('method="POST" action="?/cancel"');
    expect(html).toContain('Open linked collaboration task');
    expect(html).toContain(
      `/app/workspaces/${workspace.id}/conversations/66666666-6666-4666-8666-666666666666/tasks/55555555-5555-4555-8555-555555555555`,
    );
  });

  it('shows resume when paused and hides edit after cancel', () => {
    const paused = render(RoutinePage, {
      props: {
        data: { ...base, routine: { ...routine, status: 'paused' } },
        form: null,
        params: { workspaceId: workspace.id, groupId: group.id, routineId: routine.id },
      },
    }).body;
    expect(paused).toContain('method="POST" action="?/resume"');
    const cancelled = render(RoutinePage, {
      props: {
        data: { ...base, routine: { ...routine, status: 'cancelled' } },
        form: null,
        params: { workspaceId: workspace.id, groupId: group.id, routineId: routine.id },
      },
    }).body;
    expect(cancelled).not.toContain('Edit routine');
    expect(cancelled).not.toContain('Pause routine');
  });
});
