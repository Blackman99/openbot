import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import InvitationsPage from '../../src/routes/app/workspaces/[workspaceId]/invitations/+page.svelte';
import JoinPage from '../../src/routes/join/+page.svelte';
import AppPage from '../../src/routes/app/+page.svelte';
const workspace = { id: 'workspace-1', name: 'Team', description: '', role: 'owner' as const };
const user = { id: 'grace', email: 'grace@example.com', displayName: 'Grace Hopper' };

describe('invitation pages', () => {
  it('shows admin invitation controls, a one-time copyable link, and workspace navigation', () => {
    const result = render(InvitationsPage, {
      props: {
        params: { workspaceId: 'workspace-1' },
        data: { user, workspace, workspaces: [workspace], invitations: [] },
        form: {
          action: 'create',
          invitationLink: `http://localhost:3000/join#token=${'a'.repeat(43)}`,
        },
      },
    });
    expect(result.body).toContain('Create invitation');
    expect(result.body).toContain('Invitation link');
    expect(result.body).toContain('readonly');
    expect(result.body).toContain('name="expiresInDays"');
    expect(
      render(AppPage, { props: { data: { user, workspace, workspaces: [workspace] } } }).body,
    ).toContain('/app/workspaces/workspace-1/invitations');
  });
  it('provides new-account and existing-account join forms without an SSR token or populated password', () => {
    const result = render(JoinPage, { props: { params: {}, form: null, data: { user: null } } });
    expect(result.body).toContain('Create account and join');
    expect(result.body).toContain('Sign in to join');
    expect(result.body).toContain('autocomplete="new-password"');
    expect(result.body).toContain('type="hidden"');
    expect(result.body).toContain('name="token" value=""');
    const existing = render(JoinPage, { props: { params: {}, form: null, data: { user } } });
    expect(existing.body).toContain('grace@example.com');
    expect(existing.body).toContain('Join workspace');
    expect(existing.body).not.toContain('name="password"');
  });
});
