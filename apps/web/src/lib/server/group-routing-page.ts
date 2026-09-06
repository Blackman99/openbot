import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { parseGroupRoutingCommand, routingUuid } from '../routing-contract.js';
import { createAuthApiClient } from './auth-api.js';
import { createWorkspaceApiClient } from './workspace-api.js';
import { createGroupApiClient } from './group-api.js';
import { createGroupBotApiClient } from './group-bot-api.js';
import { createGroupRoutingApiClient } from './group-routing-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
type Context = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders' | 'request' | 'url'>;
function validPageQuery(url: URL) {
  // SvelteKit keeps its named-action marker during the load after an action failure.
  return (
    url.searchParams.size === 0 ||
    (url.searchParams.size === 1 && url.searchParams.get('/update') === '')
  );
}
function readFailure(status: string, context: Context): never {
  if (status === 'anonymous') {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  if (status === 'forbidden' || status === 'not-found')
    error(403, 'Current group access is required');
  if (status === 'invalid') error(400, 'Invalid group routing request');
  error(503, 'Group routing unavailable');
}
export async function loadGroupRoutingPage(context: Context, workspaceId: string, groupId: string) {
  preventAuthenticationCaching(context.setHeaders);
  if (!routingUuid(workspaceId) || !routingUuid(groupId) || !validPageQuery(context.url))
    readFailure('invalid', context);
  const session = readSessionCookie(context.cookies);
  const identity = await createAuthApiClient(context.fetch).getIdentity(session);
  if (identity.status !== 'authenticated') readFailure(identity.status, context);
  const workspaces = await createWorkspaceApiClient(context.fetch).list(session);
  if (workspaces.status !== 'available') readFailure(workspaces.status, context);
  const workspace = workspaces.value.find((value) => value.id === workspaceId.toLowerCase());
  if (!workspace) readFailure('forbidden', context);
  const group = await createGroupApiClient(context.fetch).get(
    session,
    workspace.id,
    groupId.toLowerCase(),
  );
  if (group.status !== 'available') readFailure(group.status, context);
  if (group.value.role === null) readFailure('forbidden', context);
  const routing = await createGroupRoutingApiClient(context.fetch, context.request.signal).get(
    session,
    workspace.id,
    groupId,
  );
  if (routing.status !== 'available') readFailure(routing.status, context);
  const candidates: Array<{
    grantId: string;
    botId: string;
    name: string;
    roleDescription: string;
  }> = [];
  if (routing.value.canManage) {
    if (group.value.role === 'member') readFailure('forbidden', context);
    const membership = await createGroupBotApiClient(context.fetch, context.request.signal).list(
      session,
      workspace.id,
      groupId,
    );
    if (membership.status !== 'available') readFailure(membership.status, context);
    if (!membership.value.canManage) readFailure('forbidden', context);
    for (const grant of membership.value.grants)
      if (grant.closed === null && grant.bot.lifecycleState === 'active')
        candidates.push({
          grantId: grant.id,
          botId: grant.bot.id,
          name: grant.bot.name,
          roleDescription: grant.bot.roleDescription,
        });
  }
  return {
    user: identity.identity.user,
    workspace,
    workspaces: workspaces.value,
    group: group.value,
    routing: routing.value,
    candidates,
  };
}
function actionFailure(status: string, context: Context, values: Record<string, string>) {
  if (status === 'anonymous') readFailure(status, context);
  const known: Record<string, [number, string]> = {
    invalid: [400, 'Choose a valid group Bot and settings revision.'],
    forbidden: [
      403,
      'Your current group or Bot access does not allow this change. Refresh the settings.',
    ],
    'revision-conflict': [
      409,
      'The settings changed after you opened this page. Refresh before choosing again.',
    ],
    'model-unavailable': [
      409,
      'This Bot model is currently unavailable to you. Choose another Bot or clear the default.',
    ],
  };
  const detail = known[status];
  return fail(detail?.[0] ?? 503, {
    values,
    conflict: status === 'revision-conflict',
    uncertain: !detail,
    error:
      detail?.[1] ??
      'The change could not be confirmed. Refresh to inspect the current default before making another change.',
  });
}
async function formValues(request: Request): Promise<Record<string, string>> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/x-www-form-urlencoded' ||
    !request.body
  )
    throw new Error('invalid_form');
  const reader = request.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  request.signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      request.signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4096) throw new Error('invalid_form');
      chunks.push(next.value);
    }
  } finally {
    request.signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(body));
  const values: Record<string, string> = {};
  for (const [key, value] of form) {
    if (
      !['expectedRevision', 'defaultGrantId'].includes(key) ||
      form.getAll(key).length !== 1 ||
      value.length > 36
    )
      throw new Error('invalid_form');
    values[key] = value;
  }
  return values;
}
export async function updateGroupRouting(context: Context, workspaceId: string, groupId: string) {
  preventAuthenticationCaching(context.setHeaders);
  if (
    context.request.headers.get('origin') !==
    new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000').origin
  )
    return actionFailure('forbidden', context, {});
  if (!validPageQuery(context.url)) return actionFailure('invalid', context, {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request);
  } catch {
    return actionFailure('invalid', context, {});
  }
  const command =
    /^(?:0|[1-9][0-9]{0,9})$/u.test(values.expectedRevision ?? '') &&
    values.defaultGrantId !== undefined
      ? parseGroupRoutingCommand({
          expectedRevision: Number(values.expectedRevision),
          defaultGrantId: values.defaultGrantId || null,
        })
      : undefined;
  if (!command) return actionFailure('invalid', context, values);
  const result = await createGroupRoutingApiClient(context.fetch, context.request.signal).update(
    readSessionCookie(context.cookies),
    workspaceId,
    groupId,
    command,
  );
  if (result.status !== 'available') return actionFailure(result.status, context, values);
  redirect(
    303,
    `/app/workspaces/${workspaceId.toLowerCase()}/groups/${groupId.toLowerCase()}/routing`,
  );
}
