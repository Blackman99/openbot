import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import GroupsPage from '../../src/routes/app/workspaces/[workspaceId]/groups/+page.svelte';
import GroupPage from '../../src/routes/app/workspaces/[workspaceId]/groups/[groupId]/+page.svelte';
import AppPage from '../../src/routes/app/+page.svelte';
import type { Group, GroupMember, GroupRole } from '../../src/lib/server/group-api.js';
const user = { id: 'ada', email: 'ada@example.com', displayName: 'Ada' };
const workspace = { id: 'workspace-1', name: 'Team', description: '', role: 'member' as const };
const group: Group = {
  id: 'group-1',
  workspaceId: workspace.id,
  name: 'Research',
  description: 'A team group',
  visibility: 'private',
  role: 'owner',
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};
const base = { user, workspace, workspaces: [workspace] };
const members: GroupMember[] = [
  { user, role: 'owner', joinedAt: group.createdAt, hasWorkspaceAccess: true },
  {
    user: { id: 'grace', email: 'grace@example.com', displayName: 'Grace' },
    role: 'owner',
    joinedAt: group.createdAt,
    hasWorkspaceAccess: false,
  },
  {
    user: { id: 'lin', email: 'lin@example.com', displayName: 'Lin' },
    role: 'member',
    joinedAt: group.createdAt,
    hasWorkspaceAccess: true,
  },
];
function detail(role: GroupRole | null) {
  return render(GroupPage, {
    props: {
      data: {
        ...base,
        workspace: { ...workspace, role: 'owner' },
        group: { ...group, role, visibility: role === null ? 'workspace' : 'private' },
        members: role === null ? [] : members,
        candidates: [],
      },
      form: null,
      params: { workspaceId: workspace.id, groupId: group.id },
    },
  }).body;
}
describe('group pages', () => {
  it('offers creation to workspace members with private default and scoped navigation', () => {
    const html = render(GroupsPage, {
      props: {
        data: {
          ...base,
          groups: [
            group,
            { ...group, id: 'group-2', name: 'News', role: null, visibility: 'workspace' },
          ],
        },
        form: null,
        params: { workspaceId: workspace.id },
      },
    }).body;
    expect(html).toContain('Groups');
    expect(html).toContain('Create group');
    expect(html).toContain('value="private" selected');
    expect(html).toContain('/app/workspaces/workspace-1/groups/group-1');
    expect(html).toContain('Metadata only · Not a member');
    expect(render(AppPage, { props: { data: base } }).body).toContain(
      '/app/workspaces/workspace-1/groups',
    );
  });
  it('shows only metadata to discoverable nonmembers, even workspace owners', () => {
    const html = detail(null);
    expect(html).toContain('Research');
    expect(html).toContain('Only group metadata is available');
    expect(html).not.toContain('Group members');
    expect(html).not.toContain('grace@example.com');
    expect(html).not.toContain('action="?/');
  });
  it('protects the only eligible owner while showing retained inactive grants to managers', () => {
    const html = detail('owner');
    expect(html).toContain('Save group settings');
    expect(html).toContain('No current workspace access');
    expect(html).toContain('Assign another eligible owner first');
    expect(html).not.toContain('Remove Ada from group');
    expect(html).toContain('Remove Grace from group');
    expect(html).toContain('Change role for Grace');
    expect(html).toContain('value="owner"');
  });
  it('limits group admins to non-owner controls and ordinary members to reads', () => {
    const admin = detail('admin');
    expect(admin).toContain('Change role for Lin');
    expect(admin).not.toContain('Change role for Grace');
    expect(admin).not.toContain('value="owner"');
    const readonly = detail('member');
    expect(readonly).toContain('grace@example.com');
    expect(readonly).not.toContain('action="?/');
    expect(readonly).toContain('Only group owners and admins can manage');
  });
});
