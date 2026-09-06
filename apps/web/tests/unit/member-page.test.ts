import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import MembersPage from '../../src/routes/app/workspaces/[workspaceId]/members/+page.svelte';
import AppPage from '../../src/routes/app/+page.svelte';
import type { MemberRole, WorkspaceMember } from '../../src/lib/server/member-api.js';

const user = { id: 'ada', email: 'ada@example.com', displayName: 'Ada Lovelace' };
const workspace = { id: 'workspace-1', name: 'Team', description: '', role: 'owner' as const };
const members: WorkspaceMember[] = [
  { user, role: 'owner', joinedAt: '2026-09-05T00:00:00.000Z', invitation: null },
  {
    user: { id: 'grace', email: 'grace@example.com', displayName: 'Grace Hopper' },
    role: 'member',
    joinedAt: '2026-09-05T01:00:00.000Z',
    invitation: { id: 'invite-1', invitedBy: { id: 'ada', displayName: 'Ada Lovelace' } },
  },
];
function page(role: MemberRole) {
  const selected = { ...workspace, role };
  return render(MembersPage, {
    props: {
      params: { workspaceId: workspace.id },
      form: null,
      data: { user, workspace: selected, workspaces: [selected], members },
    },
  }).body;
}
describe('workspace members page', () => {
  it('shows scoped membership, provenance, authority controls and last-owner protection', () => {
    const html = page('owner');
    expect(html).toContain('Workspace members');
    expect(html).toContain('grace@example.com');
    expect(html).toContain('Invited by Ada Lovelace');
    expect(html).toContain('Direct membership');
    expect(html).toContain('Change role for Grace Hopper');
    expect(html).toContain('value="owner"');
    expect(html).not.toContain('Remove Ada Lovelace from workspace');
    expect(html).toContain('Assign another owner first');
    expect(html).toContain('Remove Grace Hopper from workspace');
    expect(
      render(AppPage, { props: { data: { user, workspace, workspaces: [workspace] } } }).body,
    ).toContain('/app/workspaces/workspace-1/members');
  });
  it('limits administrators to non-owner controls and shows members a read-only list', () => {
    const admin = page('administrator');
    expect(admin).toContain('Change role for Grace Hopper');
    expect(admin).not.toContain('value="owner"');
    expect(admin).not.toContain('Change role for Ada Lovelace');
    expect(admin).not.toContain('Remove Ada Lovelace from workspace');
    const readonly = page('member');
    expect(readonly).toContain('grace@example.com');
    expect(readonly).not.toContain('action="?/changeRole"');
    expect(readonly).not.toContain('action="?/remove"');
    expect(readonly).toContain('Only workspace owners and administrators');
    const selected = { ...workspace, role: 'member' as const };
    expect(
      render(AppPage, { props: { data: { user, workspace: selected, workspaces: [selected] } } })
        .body,
    ).toContain('/app/workspaces/workspace-1/members');
  });
  it('renders a role change result and escapes user supplied names and invitation sources', () => {
    const member: WorkspaceMember = {
      ...members[0]!,
      user: { ...user, displayName: '<script>private()</script>' },
      invitation: {
        id: 'invite-2',
        invitedBy: { id: 'inviter', displayName: '<img src=x onerror=private()>' },
      },
    };
    const html = render(MembersPage, {
      props: {
        params: { workspaceId: workspace.id },
        form: { action: 'changeRole', message: 'Grace Hopper is now an administrator.' },
        data: { user, workspace, workspaces: [workspace], members: [member] },
      },
    }).body;
    expect(html).toContain('role="status"');
    expect(html).toContain('Grace Hopper is now an administrator.');
    expect(html).not.toContain('<script>private()');
    expect(html).not.toContain('<img src=x');
  });
});
