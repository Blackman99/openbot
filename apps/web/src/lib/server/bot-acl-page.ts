import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { loadBotPage } from './bot-page.js';
import { createBotAclApiClient, isBotAclRole } from './bot-acl-api.js';
import { createAuthApiClient } from './auth-api.js';
import { createMemberApiClient } from './member-api.js';
import { isBotUuid } from './bot-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
type PageContext = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
type AclAction = 'grant' | 'changeRole' | 'revoke' | 'visibility';
function actionFailure(status: string, action: AclAction, context: PageContext) {
  if (status === 'anonymous') readFailure(status, context);
  if (status === 'forbidden')
    return fail(403, {
      action,
      error:
        'You no longer have permission to make this change. Reload to see your current Bot access.',
    });
  if (status === 'invalid')
    return fail(400, {
      action,
      error: 'Choose a valid workspace member, Bot role, or discovery setting.',
    });
  if (status === 'not-found')
    return fail(404, {
      action,
      error:
        'This grant no longer exists or the person is not an eligible workspace member. Reload the permissions page.',
    });
  if (status === 'conflict')
    return fail(409, {
      action,
      error:
        'This grant changed or the person is not an eligible workspace member. Reload the permissions page.',
    });
  if (status === 'last-owner')
    return fail(409, {
      action,
      error:
        'The Bot must keep an owner with current workspace access. Grant another eligible person owner access first.',
    });
  return fail(503, { action, error: 'Bot permissions unavailable. Try again.' });
}
export async function botAclAction(
  context: PageContext & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  botId: string,
  action: AclAction,
) {
  preventAuthenticationCaching(context.setHeaders);
  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return actionFailure('invalid', action, context);
  }
  const allowed =
    action === 'visibility'
      ? ['visibility']
      : action === 'revoke'
        ? ['userId']
        : ['userId', 'role'];
  if (
    Array.from(form.keys()).some(
      (key) =>
        !allowed.includes(key) ||
        form.getAll(key).length !== 1 ||
        typeof form.get(key) !== 'string',
    )
  )
    return actionFailure('invalid', action, context);
  const client = createBotAclApiClient(context.fetch);
  const session = readSessionCookie(context.cookies);
  if (action === 'visibility') {
    const visibility = form.get('visibility');
    if (visibility !== 'private' && visibility !== 'workspace')
      return actionFailure('invalid', action, context);
    const result = await client.setVisibility(session, workspaceId, botId, visibility);
    if (result.status !== 'available') return actionFailure(result.status, action, context);
    return { action, message: 'Bot discovery settings saved.' };
  }
  const userId = form.get('userId');
  const role = form.get('role') ?? (action === 'grant' ? 'user' : undefined);
  if (!isBotUuid(userId) || (action !== 'revoke' && !isBotAclRole(role)))
    return actionFailure('invalid', action, context);
  const target = userId.toLowerCase();
  let self = false;
  if (action === 'changeRole' || action === 'revoke') {
    const identity = await createAuthApiClient(context.fetch).getIdentity(session);
    if (identity.status !== 'authenticated') return actionFailure(identity.status, action, context);
    self = identity.identity.user.id.toLowerCase() === target;
  }
  if (action === 'revoke') {
    const result = await client.revoke(session, workspaceId, botId, target);
    if (result.status !== 'available') return actionFailure(result.status, action, context);
    if (self) redirect(303, `/app/workspaces/${workspaceId.toLowerCase()}/bots`);
    return { action, message: 'Bot access revoked.' };
  }
  if (!isBotAclRole(role)) return actionFailure('invalid', action, context);
  const result =
    action === 'grant'
      ? await client.grant(session, workspaceId, botId, target, role)
      : await client.changeRole(session, workspaceId, botId, target, role);
  if (result.status !== 'available') return actionFailure(result.status, action, context);
  if (self && role !== 'owner')
    redirect(303, `/app/workspaces/${workspaceId.toLowerCase()}/bots/${botId.toLowerCase()}`);
  return {
    action,
    message: `${result.value.user.displayName} now has ${result.value.role} access.`,
  };
}
function readFailure(status: string, context: PageContext): never {
  if (status === 'anonymous') {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  if (status === 'forbidden' || status === 'invalid')
    error(403, 'Only a current Bot owner can manage permissions');
  error(503, 'Bot permissions unavailable');
}
export async function loadBotPermissionsPage(
  context: PageContext,
  workspaceId: string,
  botId: string,
) {
  const page = await loadBotPage(context, workspaceId, botId);
  if (page.bot.accessRole !== 'owner') readFailure('forbidden', context);
  const session = readSessionCookie(context.cookies);
  const acl = await createBotAclApiClient(context.fetch).list(session, workspaceId, botId);
  if (acl.status !== 'available') readFailure(acl.status, context);
  const current = acl.value.find(({ user }) => user.id === page.user.id.toLowerCase());
  if (current?.role !== 'owner' || !current.hasWorkspaceAccess) readFailure('forbidden', context);
  const people = await createMemberApiClient(context.fetch).list(
    session,
    workspaceId.toLowerCase(),
  );
  if (people.status !== 'available') readFailure(people.status, context);
  const ids = new Set(acl.value.map(({ user }) => user.id));
  const seen = new Set<string>();
  const candidates: Array<{ id: string; email: string; displayName: string }> = [];
  for (const { user } of people.value) {
    if (!isBotUuid(user.id) || seen.has(user.id.toLowerCase())) readFailure('unavailable', context);
    const id = user.id.toLowerCase();
    seen.add(id);
    if (!ids.has(id)) candidates.push({ ...user, id });
  }
  return {
    ...page,
    bot: { id: page.bot.id, name: page.bot.name, visibility: page.bot.visibility },
    members: acl.value,
    candidates,
  };
}
