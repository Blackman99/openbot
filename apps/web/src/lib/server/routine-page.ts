import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createAuthApiClient } from './auth-api.js';
import { createWorkspaceApiClient } from './workspace-api.js';
import { createGroupApiClient } from './group-api.js';
import { createGroupBotApiClient } from './group-bot-api.js';
import {
  createRoutineApiClient,
  isRoutineUuid,
  type CreateRoutineInput,
  type EditRoutineInput,
  type RoutineResult,
} from './routine-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';

type Context = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders' | 'request' | 'url'>;

function readFailure(status: string, context: Context): never {
  if (status === 'anonymous') {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  if (status === 'forbidden' || status === 'not-found')
    error(403, 'Current group access is required to manage routines');
  if (status === 'invalid') error(400, 'Invalid routine request');
  error(503, 'Routines unavailable');
}

async function scope(context: Context, workspaceId: string, groupId: string) {
  preventAuthenticationCaching(context.setHeaders);
  if (!isRoutineUuid(workspaceId) || !isRoutineUuid(groupId)) readFailure('invalid', context);
  const session = readSessionCookie(context.cookies);
  const identity = await createAuthApiClient(context.fetch).getIdentity(session);
  if (identity.status !== 'authenticated') readFailure(identity.status, context);
  const workspaces = await createWorkspaceApiClient(context.fetch).list(session);
  if (workspaces.status !== 'available') readFailure(workspaces.status, context);
  const workspace = workspaces.value.find((item) => item.id === workspaceId.toLowerCase());
  if (!workspace) readFailure('forbidden', context);
  const group = await createGroupApiClient(context.fetch).get(session, workspace.id, groupId);
  if (group.status !== 'available') readFailure(group.status, context);
  if (group.value.role === null) readFailure('forbidden', context);
  return {
    session,
    user: identity.identity.user,
    workspace,
    workspaces: workspaces.value,
    group: group.value,
  };
}

function actionFail(
  status: Exclude<RoutineResult<unknown>, { status: 'available' }>['status'],
  values: Record<string, string>,
  code?: string,
) {
  const messages: Record<string, string> = {
    invalid: 'Check the prompt, schedule, time zone, and budget, then try again.',
    forbidden: 'Your current group access does not allow this routine change.',
    conflict: code
      ? `This routine cannot change right now (${code.replaceAll('_', ' ')}).`
      : 'This routine cannot change in its current state.',
    unavailable: 'The routine service is temporarily unavailable. Try again shortly.',
    anonymous: 'Sign in again to manage routines.',
  };
  const statusCode =
    status === 'invalid' ? 400 : status === 'forbidden' ? 403 : status === 'conflict' ? 409 : 503;
  return fail(statusCode, { values, error: messages[status] ?? messages.unavailable });
}

async function formValues(request: Request): Promise<Record<string, string>> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/x-www-form-urlencoded' ||
    !request.body
  )
    return {};
  const data = await request.formData();
  const values: Record<string, string> = {};
  for (const [key, value] of data.entries()) if (typeof value === 'string') values[key] = value;
  return values;
}

function parseInstant(value: string): string | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function parseCreate(values: Record<string, string>): CreateRoutineInput | undefined {
  const maxCostMicros = Number(values.maxCostMicros);
  const executeAt = values.executeAt?.trim() ? parseInstant(values.executeAt) : undefined;
  const expiresAt = values.expiresAt?.trim() ? parseInstant(values.expiresAt) : undefined;
  if (
    !values.prompt?.trim() ||
    !values.timeZone?.trim() ||
    !executeAt ||
    !expiresAt ||
    !Number.isInteger(maxCostMicros) ||
    maxCostMicros <= 0
  )
    return undefined;
  return {
    prompt: values.prompt,
    timeZone: values.timeZone.trim(),
    executeAt,
    expiresAt,
    maxCostMicros,
    ...(values.leadGrantId?.trim() ? { leadGrantId: values.leadGrantId.trim().toLowerCase() } : {}),
  };
}

function parseEdit(values: Record<string, string>): EditRoutineInput | undefined {
  const next: EditRoutineInput = {};
  if (values.prompt !== undefined && values.prompt !== '') next.prompt = values.prompt;
  if (values.timeZone?.trim()) next.timeZone = values.timeZone.trim();
  if (values.executeAt?.trim()) {
    const executeAt = parseInstant(values.executeAt);
    if (!executeAt) return undefined;
    next.executeAt = executeAt;
  }
  if (values.expiresAt?.trim()) {
    const expiresAt = parseInstant(values.expiresAt);
    if (!expiresAt) return undefined;
    next.expiresAt = expiresAt;
  }
  if (values.maxCostMicros?.trim()) {
    const maxCostMicros = Number(values.maxCostMicros);
    if (!Number.isInteger(maxCostMicros) || maxCostMicros <= 0) return undefined;
    next.maxCostMicros = maxCostMicros;
  }
  if (values.leadGrantId === '') next.leadGrantId = null;
  else if (values.leadGrantId?.trim()) next.leadGrantId = values.leadGrantId.trim().toLowerCase();
  if (!Object.keys(next).length) return undefined;
  return next;
}

export async function loadRoutinesPage(context: Context, workspaceId: string, groupId: string) {
  const page = await scope(context, workspaceId, groupId);
  const routines = await createRoutineApiClient(context.fetch).list(
    page.session,
    page.workspace.id,
    page.group.id,
  );
  if (routines.status !== 'available') readFailure(routines.status, context);
  const membership = await createGroupBotApiClient(context.fetch).list(
    page.session,
    page.workspace.id,
    page.group.id,
  );
  const grants =
    membership.status === 'available'
      ? membership.value.grants.filter((grant) => grant.closed === null)
      : [];
  return {
    user: page.user,
    workspace: page.workspace,
    workspaces: page.workspaces,
    group: page.group,
    routines: routines.value,
    grants: grants.map((grant) => ({
      id: grant.id,
      name: grant.bot.name,
    })),
  };
}

export async function loadRoutinePage(
  context: Context,
  workspaceId: string,
  groupId: string,
  routineId: string,
) {
  if (!isRoutineUuid(routineId)) readFailure('invalid', context);
  const page = await scope(context, workspaceId, groupId);
  const routine = await createRoutineApiClient(context.fetch).get(
    page.session,
    page.workspace.id,
    page.group.id,
    routineId,
  );
  if (routine.status !== 'available') readFailure(routine.status, context);
  const membership = await createGroupBotApiClient(context.fetch).list(
    page.session,
    page.workspace.id,
    page.group.id,
  );
  const grants =
    membership.status === 'available'
      ? membership.value.grants.filter((grant) => grant.closed === null)
      : [];
  return {
    user: page.user,
    workspace: page.workspace,
    workspaces: page.workspaces,
    group: page.group,
    routine: routine.value,
    grants: grants.map((grant) => ({
      id: grant.id,
      name: grant.bot.name,
    })),
  };
}

export async function createRoutineAction(context: Context, workspaceId: string, groupId: string) {
  const values = await formValues(context.request);
  const input = parseCreate(values);
  if (!input) return actionFail('invalid', values);
  const page = await scope(context, workspaceId, groupId);
  const created = await createRoutineApiClient(context.fetch).create(
    page.session,
    page.workspace.id,
    page.group.id,
    input,
  );
  if (created.status !== 'available') return actionFail(created.status, values, created.code);
  redirect(
    303,
    `/app/workspaces/${page.workspace.id}/groups/${page.group.id}/routines/${created.value.id}`,
  );
}

export async function editRoutineAction(
  context: Context,
  workspaceId: string,
  groupId: string,
  routineId: string,
) {
  const values = await formValues(context.request);
  const input = parseEdit(values);
  if (!input || !isRoutineUuid(routineId)) return actionFail('invalid', values);
  const page = await scope(context, workspaceId, groupId);
  const edited = await createRoutineApiClient(context.fetch).edit(
    page.session,
    page.workspace.id,
    page.group.id,
    routineId,
    input,
  );
  if (edited.status !== 'available') return actionFail(edited.status, values, edited.code);
  return { message: 'Routine updated.', routine: edited.value };
}

export async function transitionRoutineAction(
  context: Context,
  workspaceId: string,
  groupId: string,
  routineId: string,
  action: 'pause' | 'resume' | 'cancel',
) {
  const values = await formValues(context.request);
  if (!isRoutineUuid(routineId)) return actionFail('invalid', values);
  const page = await scope(context, workspaceId, groupId);
  const result = await createRoutineApiClient(context.fetch).transition(
    page.session,
    page.workspace.id,
    page.group.id,
    routineId,
    action,
  );
  if (result.status !== 'available') return actionFail(result.status, values, result.code);
  return {
    message:
      action === 'pause'
        ? 'Routine paused.'
        : action === 'resume'
          ? 'Routine resumed.'
          : 'Routine cancelled.',
    routine: result.value,
  };
}
