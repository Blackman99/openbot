import { randomUUID } from 'node:crypto';
import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createAuthApiClient } from './auth-api.js';
import { createWorkspaceApiClient } from './workspace-api.js';
import { createGroupApiClient } from './group-api.js';
import { createBotApiClient, isBotUuid } from './bot-api.js';
import { createGroupBotApiClient, parseHistoryChoice } from './group-bot-api.js';
import { isCommandKey } from './conversation-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
type Context = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
function readFailure(status: string, context: Context): never {
  if (status === 'anonymous') {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  if (status === 'forbidden' || status === 'not-found')
    error(403, 'Current group membership is required');
  if (status === 'invalid') error(400, 'Invalid group Bot request');
  if (status === 'inactive')
    error(409, 'This Bot membership is closed. Return to the group to see current memberships.');
  error(503, 'Group Bots unavailable');
}
async function scope(context: Context, workspaceId: string, groupId: string) {
  preventAuthenticationCaching(context.setHeaders);
  if (!isBotUuid(workspaceId) || !isBotUuid(groupId)) readFailure('invalid', context);
  const session = readSessionCookie(context.cookies);
  const identity = await createAuthApiClient(context.fetch).getIdentity(session);
  if (identity.status !== 'authenticated') readFailure(identity.status, context);
  const workspaces = await createWorkspaceApiClient(context.fetch).list(session);
  if (workspaces.status !== 'available') readFailure(workspaces.status, context);
  const workspace = workspaces.value.find(({ id }) => id === workspaceId.toLowerCase());
  if (!workspace) readFailure('forbidden', context);
  const result = await createGroupApiClient(context.fetch).get(
    session,
    workspace.id,
    groupId.toLowerCase(),
  );
  if (result.status !== 'available') readFailure(result.status, context);
  if (result.value.role === null) readFailure('forbidden', context);
  const membership = await createGroupBotApiClient(context.fetch).list(
    session,
    workspace.id,
    groupId,
  );
  if (membership.status !== 'available') readFailure(membership.status, context);
  return {
    user: identity.identity.user,
    workspace,
    workspaces: workspaces.value,
    group: result.value,
    membership: membership.value,
  };
}
export async function loadGroupBotsPage(context: Context, workspaceId: string, groupId: string) {
  const page = await scope(context, workspaceId, groupId);
  const candidates: Array<{ id: string; name: string; roleDescription: string }> = [];
  if (page.membership.canManage) {
    const bots = await createBotApiClient(context.fetch).list(
      readSessionCookie(context.cookies),
      page.workspace.id,
    );
    if (bots.status !== 'available') readFailure(bots.status, context);
    for (const bot of bots.value)
      if (bot.accessRole !== null && bot.lifecycleState === 'active')
        candidates.push({ id: bot.id, name: bot.name, roleDescription: bot.roleDescription });
  }
  return {
    ...page,
    candidates,
    commands: {
      invite: String(randomUUID()),
      remove: Object.fromEntries(
        page.membership.grants
          .filter((grant) => grant.closed === null)
          .map((grant) => [grant.id, String(randomUUID())]),
      ),
    },
  };
}
type Action = 'invite' | 'remove';
function actionFailure(
  status: string,
  context: Context,
  action: Action,
  values: Record<string, string>,
) {
  if (status === 'anonymous') readFailure(status, context);
  const errors: Record<string, [number, string]> = {
    forbidden: [
      403,
      'Your current group or Bot access does not allow this change. Refresh the group memberships.',
    ],
    invalid: [
      400,
      'Choose a valid Bot and history boundary. Times must be ISO UTC and cannot be in the future.',
    ],
    'idempotency-conflict': [
      409,
      'This command key was already used with different choices. Refresh before starting a new operation.',
    ],
    'already-active': [
      409,
      'This Bot already has an active group membership. Refresh the group memberships.',
    ],
    limit: [409, 'This group already has eight active Bots. Remove a Bot before inviting another.'],
    inactive: [
      409,
      'This exact Bot membership has closed. Refresh before choosing a current membership.',
    ],
  };
  const known = errors[status];
  return fail(known?.[0] ?? 503, {
    action,
    values,
    uncertain: !known,
    conflict: known?.[0] === 409,
    error:
      known?.[1] ??
      'The result could not be confirmed. Retry the unchanged choices with the same command key, or refresh to inspect current memberships.',
  });
}
export async function groupBotAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  groupId: string,
  action: Action,
) {
  preventAuthenticationCaching(context.setHeaders);
  if (
    context.request.headers.get('origin') !==
    new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000').origin
  )
    return actionFailure('forbidden', context, action, {});
  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return actionFailure('invalid', context, action, {});
  }
  const allowed =
    action === 'invite'
      ? ['idempotencyKey', 'botId', 'mode', 'eventId', 'time']
      : ['idempotencyKey', 'grantId'];
  const values: Record<string, string> = {};
  for (const key of form.keys()) {
    const value = form.get(key);
    if (
      !allowed.includes(key) ||
      form.getAll(key).length !== 1 ||
      typeof value !== 'string' ||
      value.length > 512
    )
      return actionFailure('invalid', context, action, {});
    values[key] = value;
  }
  if (!isCommandKey(values.idempotencyKey))
    return actionFailure('invalid', context, action, values);
  const client = createGroupBotApiClient(context.fetch, context.request.signal);
  const session = readSessionCookie(context.cookies);
  if (action === 'invite') {
    const mode = values.mode ?? 'future-only';
    const history = parseHistoryChoice({
      mode,
      ...(values.eventId ? { eventId: values.eventId } : {}),
      ...(values.time ? { time: values.time } : {}),
    });
    if (!isBotUuid(values.botId) || !history)
      return actionFailure('invalid', context, action, values);
    const result = await client.invite(session, workspaceId, groupId, {
      botId: values.botId,
      idempotencyKey: values.idempotencyKey,
      history,
    });
    if (result.status !== 'available') return actionFailure(result.status, context, action, values);
  } else {
    if (!isBotUuid(values.grantId)) return actionFailure('invalid', context, action, values);
    const result = await client.remove(session, workspaceId, groupId, values.grantId, {
      idempotencyKey: values.idempotencyKey,
    });
    if (result.status !== 'available') return actionFailure(result.status, context, action, values);
  }
  redirect(
    303,
    `/app/workspaces/${workspaceId.toLowerCase()}/groups/${groupId.toLowerCase()}/bots`,
  );
}
export async function loadGroupBotContextPage(
  context: Context & Pick<RequestEvent, 'url'>,
  workspaceId: string,
  groupId: string,
  grantId: string,
) {
  if (
    !isBotUuid(grantId) ||
    context.url.searchParams.getAll('cursor').length > 1 ||
    [...context.url.searchParams.keys()].some((key) => key !== 'cursor')
  )
    readFailure('invalid', context);
  const page = await scope(context, workspaceId, groupId);
  const grant = page.membership.grants.find((item) => item.id === grantId.toLowerCase());
  if (!grant) readFailure('forbidden', context);
  if (grant.closed !== null) readFailure('inactive', context);
  const cursor = context.url.searchParams.get('cursor');
  const result = await createGroupBotApiClient(context.fetch).context(
    readSessionCookie(context.cookies),
    workspaceId,
    groupId,
    grantId,
    cursor === null ? {} : { cursor },
  );
  if (result.status !== 'available') readFailure(result.status, context);
  if (result.value.conversationId !== grant.conversationId) readFailure('unavailable', context);
  return {
    user: page.user,
    workspace: page.workspace,
    workspaces: page.workspaces,
    group: page.group,
    grant,
    context: result.value,
  };
}
