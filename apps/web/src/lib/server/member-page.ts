import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createMemberApiClient, type MemberResult } from './member-api.js';
import { createAuthApiClient } from './auth-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
import { loadWorkspacePage } from './workspace-page.js';

type PageContext = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
type ActionContext = PageContext & Pick<RequestEvent, 'request'>;
function managementFailure(
  result: Exclude<MemberResult<unknown>, { status: 'available' }>,
  action: 'changeRole' | 'remove',
  cookies: PageContext['cookies'],
) {
  if (result.status === 'anonymous') {
    clearSessionCookie(cookies);
    redirect(303, '/sign-in');
  }
  if (result.status === 'forbidden')
    return fail(403, {
      action,
      error: 'You do not have permission to manage this member. Reload to see your current role.',
    });
  if (result.status === 'not-found')
    return fail(404, {
      action,
      error: 'This member is no longer in the workspace. Reload the members list.',
    });
  if (result.status === 'invalid')
    return fail(400, { action, error: 'Select a member and a valid workspace role.' });
  if (result.status === 'last-owner')
    return fail(409, {
      action,
      error:
        'The workspace must keep at least one owner. Assign another owner before changing or removing the last owner.',
    });
  error(503, 'Member service unavailable');
}
export async function loadMembersPage(context: PageContext, workspaceId: string) {
  const page = await loadWorkspacePage(context, workspaceId);
  const result = await createMemberApiClient(context.fetch).list(
    readSessionCookie(context.cookies),
    workspaceId,
  );
  if (result.status === 'anonymous') {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  if (result.status === 'forbidden' || result.status === 'not-found')
    error(403, 'You cannot access members of this workspace');
  if (result.status !== 'available') error(503, 'Member service unavailable');
  const currentMember = result.value.find(({ user }) => user.id === page.user.id);
  if (!currentMember) error(403, 'You cannot access members of this workspace');
  return {
    ...page,
    workspace: { ...page.workspace, role: currentMember.role },
    members: result.value,
  };
}
export async function changeMemberRoleAction(
  { cookies, fetch, request, setHeaders }: ActionContext,
  workspaceId: string,
) {
  preventAuthenticationCaching(setHeaders);
  const form = await request.formData();
  const userId = form.get('userId');
  const role = form.get('role');
  if (
    typeof userId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(userId) ||
    (role !== 'owner' && role !== 'administrator' && role !== 'member')
  )
    return managementFailure({ status: 'invalid' }, 'changeRole', cookies);
  const result = await createMemberApiClient(fetch).changeRole(
    readSessionCookie(cookies),
    workspaceId,
    userId,
    role,
  );
  if (result.status !== 'available') return managementFailure(result, 'changeRole', cookies);
  return {
    action: 'changeRole' as const,
    message: `${result.value.user.displayName} is now ${role === 'member' ? 'a member' : `an ${role}`}.`,
  };
}
export async function removeMemberAction(
  { cookies, fetch, request, setHeaders }: ActionContext,
  workspaceId: string,
) {
  preventAuthenticationCaching(setHeaders);
  const form = await request.formData();
  const userId = form.get('userId');
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(userId))
    return managementFailure({ status: 'invalid' }, 'remove', cookies);
  const session = readSessionCookie(cookies);
  const identity = await createAuthApiClient(fetch).getIdentity(session);
  if (identity.status !== 'authenticated')
    return managementFailure({ status: identity.status }, 'remove', cookies);
  const result = await createMemberApiClient(fetch).remove(session, workspaceId, userId);
  if (result.status !== 'available') return managementFailure(result, 'remove', cookies);
  if (identity.identity.user.id === userId) redirect(303, '/app');
  return {
    action: 'remove' as const,
    message: 'Member removed from this workspace. Their account and history are preserved.',
  };
}
