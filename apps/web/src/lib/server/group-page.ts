import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createAuthApiClient } from './auth-api.js';
import { createWorkspaceApiClient } from './workspace-api.js';
import {
  createGroupApiClient,
  normalizeUuid,
  type GroupInput,
  type GroupRole,
  type GroupMember,
  type GroupResult,
} from './group-api.js';
import { createMemberApiClient, type WorkspaceMember } from './member-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
type PageContext = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
function readFailure(
  status: Exclude<GroupResult<unknown>, { status: 'available' }>['status'],
  cookies: PageContext['cookies'],
): never {
  if (status === 'anonymous') {
    clearSessionCookie(cookies);
    redirect(303, '/sign-in');
  }
  if (status === 'forbidden' || status === 'not-found')
    error(403, 'You cannot access this group or workspace');
  error(503, 'Group service unavailable');
}
async function requireWorkspace(context: PageContext, workspaceId: string) {
  preventAuthenticationCaching(context.setHeaders);
  const session = readSessionCookie(context.cookies);
  const identity = await createAuthApiClient(context.fetch).getIdentity(session);
  if (identity.status !== 'authenticated') readFailure(identity.status, context.cookies);
  const result = await createWorkspaceApiClient(context.fetch).list(session);
  if (result.status !== 'available') readFailure(result.status, context.cookies);
  const workspace = result.value.find(({ id }) => id === normalizeUuid(workspaceId));
  if (!workspace) error(403, 'You cannot access this workspace');
  return { user: identity.identity.user, workspace, workspaces: result.value };
}
export async function loadGroupsPage(context: PageContext, workspaceId: string) {
  const page = await requireWorkspace(context, workspaceId);
  const result = await createGroupApiClient(context.fetch).list(
    readSessionCookie(context.cookies),
    workspaceId,
  );
  if (result.status !== 'available') readFailure(result.status, context.cookies);
  return { ...page, groups: result.value };
}
export async function loadGroupPage(context: PageContext, workspaceId: string, groupId: string) {
  const page = await requireWorkspace(context, workspaceId);
  const result = await createGroupApiClient(context.fetch).get(
    readSessionCookie(context.cookies),
    workspaceId,
    groupId,
  );
  if (result.status !== 'available') readFailure(result.status, context.cookies);
  const members: GroupMember[] = [];
  let candidates: WorkspaceMember[] = [];
  let group = result.value;
  if (group.role !== null) {
    const membership = await createGroupApiClient(context.fetch).members(
      readSessionCookie(context.cookies),
      workspaceId,
      groupId,
    );
    if (membership.status !== 'available') readFailure(membership.status, context.cookies);
    const current = membership.value.find(({ user }) => user.id === page.user.id);
    if (!current?.hasWorkspaceAccess) error(403, 'You cannot access this group');
    members.push(...membership.value);
    group = { ...group, role: current.role };
    if (current.role === 'owner' || current.role === 'admin') {
      const workspaceMembers = await createMemberApiClient(context.fetch).list(
        readSessionCookie(context.cookies),
        workspaceId,
      );
      if (workspaceMembers.status !== 'available')
        readFailure(workspaceMembers.status, context.cookies);
      const ids = new Set(members.map(({ user }) => user.id));
      candidates = workspaceMembers.value.filter(({ user }) => !ids.has(user.id));
    }
  }
  return { ...page, group, members, candidates };
}

type ActionContext = PageContext & Pick<RequestEvent, 'request'>;
type GroupAction = 'create' | 'update' | 'add' | 'changeRole' | 'remove';
function actionFailure(
  status: Exclude<GroupResult<unknown>, { status: 'available' }>['status'],
  action: GroupAction,
  cookies: PageContext['cookies'],
) {
  if (status === 'anonymous') readFailure(status, cookies);
  if (status === 'forbidden')
    return fail(403, {
      action,
      error:
        'You do not have permission to make this change. Reload to see your current group role.',
    });
  if (status === 'not-found')
    return fail(404, {
      action,
      error: 'This person is no longer a group member. Reload the members list.',
    });
  if (status === 'invalid')
    return fail(400, {
      action,
      error:
        'Use a name of 1–100 characters, a description of up to 2,000 characters, and valid visibility or member roles.',
    });
  if (status === 'conflict')
    return fail(409, {
      action,
      error: 'This person already has a group membership. Reload the members list.',
    });
  if (status === 'last-owner')
    return fail(409, {
      action,
      error:
        'The group must keep an owner with current workspace access. Assign another eligible owner first.',
    });
  error(503, 'Group service unavailable');
}
function metadata(form: FormData): GroupInput | undefined {
  const name = form.get('name');
  const description = form.get('description') ?? '';
  const visibility = form.get('visibility') ?? 'private';
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 100 ||
    typeof description !== 'string' ||
    description.trim().length > 2000 ||
    (visibility !== 'private' && visibility !== 'workspace')
  )
    return undefined;
  return { name: name.trim(), description: description.trim(), visibility };
}
export async function createGroupAction(context: ActionContext, workspaceId: string) {
  preventAuthenticationCaching(context.setHeaders);
  const input = metadata(await context.request.formData());
  if (!input) return actionFailure('invalid', 'create', context.cookies);
  const result = await createGroupApiClient(context.fetch).create(
    readSessionCookie(context.cookies),
    workspaceId,
    input,
  );
  if (result.status !== 'available') return actionFailure(result.status, 'create', context.cookies);
  redirect(
    303,
    `/app/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(result.value.id)}`,
  );
}
export async function updateGroupAction(
  context: ActionContext,
  workspaceId: string,
  groupId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  const input = metadata(await context.request.formData());
  if (!input) return actionFailure('invalid', 'update', context.cookies);
  const result = await createGroupApiClient(context.fetch).update(
    readSessionCookie(context.cookies),
    workspaceId,
    groupId,
    input,
  );
  if (result.status !== 'available') return actionFailure(result.status, 'update', context.cookies);
  return { action: 'update' as const, message: 'Group settings saved.' };
}
function memberTarget(form: FormData): { userId: string; role: GroupRole } | undefined {
  const userId = form.get('userId');
  const role = form.get('role');
  if (
    typeof userId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(userId) ||
    (role !== 'owner' && role !== 'admin' && role !== 'member')
  )
    return undefined;
  return { userId, role };
}
async function writeMemberAction(
  context: ActionContext,
  workspaceId: string,
  groupId: string,
  action: 'add' | 'changeRole',
) {
  preventAuthenticationCaching(context.setHeaders);
  const target = memberTarget(await context.request.formData());
  if (!target) return actionFailure('invalid', action, context.cookies);
  const client = createGroupApiClient(context.fetch);
  const session = readSessionCookie(context.cookies);
  const result =
    action === 'add'
      ? await client.addMember(session, workspaceId, groupId, target.userId, target.role)
      : await client.changeRole(session, workspaceId, groupId, target.userId, target.role);
  if (result.status !== 'available') return actionFailure(result.status, action, context.cookies);
  return {
    action,
    message:
      action === 'add'
        ? `${result.value.user.displayName} added to the group.`
        : `${result.value.user.displayName} is now ${result.value.role}.`,
  };
}
export async function addGroupMemberAction(
  context: ActionContext,
  workspaceId: string,
  groupId: string,
) {
  return writeMemberAction(context, workspaceId, groupId, 'add');
}
export async function changeGroupMemberRoleAction(
  context: ActionContext,
  workspaceId: string,
  groupId: string,
) {
  return writeMemberAction(context, workspaceId, groupId, 'changeRole');
}
export async function removeGroupMemberAction(
  context: ActionContext,
  workspaceId: string,
  groupId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  const userId = (await context.request.formData()).get('userId');
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(userId))
    return actionFailure('invalid', 'remove', context.cookies);
  const session = readSessionCookie(context.cookies);
  const identity = await createAuthApiClient(context.fetch).getIdentity(session);
  if (identity.status !== 'authenticated')
    return actionFailure(identity.status, 'remove', context.cookies);
  const result = await createGroupApiClient(context.fetch).removeMember(
    session,
    workspaceId,
    groupId,
    userId,
  );
  if (result.status !== 'available') return actionFailure(result.status, 'remove', context.cookies);
  if (identity.identity.user.id === normalizeUuid(userId))
    redirect(303, `/app/workspaces/${encodeURIComponent(workspaceId)}/groups`);
  return {
    action: 'remove' as const,
    message: 'Member removed from this group. Their account and history are preserved.',
  };
}
