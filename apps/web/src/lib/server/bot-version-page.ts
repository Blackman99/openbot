import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { loadBotPage, loadBotModelChoices } from './bot-page.js';
import { isBotDetail, isBotUuid } from './bot-api.js';
import {
  createBotVersionApiClient,
  parseBotVersionChanges,
  versionLimitBounds,
  type BotVersionResult,
} from './bot-version-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';

type Context = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
type Action = 'edit' | 'restore';
function readFailure(status: string, context: Context): never {
  if (status === 'anonymous') {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  if (status === 'forbidden') error(403, 'You cannot inspect or edit this Bot version');
  if (status === 'not-found') error(404, 'Bot version not found');
  if (status === 'invalid') error(400, 'Invalid Bot version request');
  error(503, 'Bot version history unavailable');
}
async function inspect(context: Context, workspaceId: string, botId: string) {
  const page = await loadBotPage(context, workspaceId, botId);
  if (!isBotDetail(page.bot)) readFailure('forbidden', context);
  return {
    ...page,
    bot: page.bot,
    canEdit: page.bot.accessRole === 'owner' || page.bot.accessRole === 'editor',
  };
}
export async function loadBotEditPage(context: Context, workspaceId: string, botId: string) {
  const page = await inspect(context, workspaceId, botId);
  if (!page.canEdit) readFailure('forbidden', context);
  return { ...page, ...(await loadBotModelChoices(context, page.workspace.id, page.user.id)) };
}
function historyQuery(url: URL) {
  const allowed = ['before', 'limit'];
  if (
    [...url.searchParams.keys()].some(
      (key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
    )
  )
    error(400, 'Invalid history page request');
  const parse = (key: string, maximum: number) => {
    const value = url.searchParams.get(key);
    if (value === null) return undefined;
    if (
      !/^[1-9][0-9]*$/u.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) > maximum
    )
      error(400, 'Invalid history page request');
    return Number(value);
  };
  const before = parse('before', 2147483647),
    limit = parse('limit', 100);
  return { ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) };
}
export async function loadVersionHistoryPage(
  context: Context & Pick<RequestEvent, 'url'>,
  workspaceId: string,
  botId: string,
) {
  const page = await inspect(context, workspaceId, botId);
  const query = historyQuery(context.url);
  const result = await createBotVersionApiClient(context.fetch).list(
    readSessionCookie(context.cookies),
    page.workspace.id,
    page.bot.id,
    query,
  );
  if (result.status !== 'available') readFailure(result.status, context);
  return { ...page, history: result.value, before: query.before ?? null, limit: query.limit ?? 50 };
}
export async function loadBotVersionPage(
  context: Context,
  workspaceId: string,
  botId: string,
  versionId: string,
) {
  const page = await inspect(context, workspaceId, botId);
  const result = await createBotVersionApiClient(context.fetch).get(
    readSessionCookie(context.cookies),
    page.workspace.id,
    page.bot.id,
    versionId,
  );
  if (result.status !== 'available') readFailure(result.status, context);
  return { ...page, version: result.value };
}
export async function loadVersionComparisonPage(
  context: Context & Pick<RequestEvent, 'url'>,
  workspaceId: string,
  botId: string,
) {
  const page = await inspect(context, workspaceId, botId);
  const fromId = context.url.searchParams.get('fromVersionId'),
    toId = context.url.searchParams.get('toVersionId');
  if (
    !isBotUuid(fromId) ||
    !isBotUuid(toId) ||
    [...context.url.searchParams.keys()].some(
      (key) =>
        !['fromVersionId', 'toVersionId'].includes(key) ||
        context.url.searchParams.getAll(key).length !== 1,
    )
  )
    readFailure('invalid', context);
  const client = createBotVersionApiClient(context.fetch),
    session = readSessionCookie(context.cookies);
  const comparison = await client.compare(session, workspaceId, botId, fromId, toId);
  if (comparison.status !== 'available') readFailure(comparison.status, context);
  const [from, to] = await Promise.all([
    client.get(session, workspaceId, botId, fromId),
    client.get(session, workspaceId, botId, toId),
  ]);
  if (from.status !== 'available') readFailure(from.status, context);
  if (to.status !== 'available') readFailure(to.status, context);
  return {
    ...page,
    comparison: comparison.value,
    fromVersion: { id: from.value.id, number: from.value.number },
    toVersion: { id: to.value.id, number: to.value.number },
  };
}
function actionFailure(
  result: Exclude<BotVersionResult<unknown>, { status: 'available' }>,
  context: Context,
  values: Record<string, string>,
) {
  const status = result.status;
  if (status === 'anonymous') readFailure(status, context);
  const modelMessage =
    result.status === 'model-unavailable'
      ? {
          disabled: 'The selected model is disabled. Enable it or choose an available model.',
          'binding-changed':
            'The connection now uses a different model. Reload the available model choices.',
          'capability-unavailable': 'The selected model needs verified text and streaming support.',
          'not-accessible':
            'You cannot use the selected model. Choose a model you currently have permission to use.',
        }[result.reason]
      : undefined;
  const message =
    modelMessage ??
    (status === 'forbidden'
      ? 'You no longer have permission to change this Bot. Reload to check current access.'
      : status === 'invalid'
        ? 'Check the field limits and version selection. Avatar changes use the existing upload or removal controls.'
        : status === 'not-found'
          ? 'This version could not be found for this Bot. Reload the version history.'
          : status === 'conflict'
            ? 'The Bot changed while you were editing. Your draft and original version are preserved. Reload the current version before submitting a new change.'
            : status === 'avatar-unavailable'
              ? 'The historical avatar is unavailable, so this version could not be restored. Choose another version or restore access to that image.'
              : 'We could not confirm this change. Your draft is preserved. Reload to inspect the current version before submitting another change.');
  return fail(
    status === 'forbidden'
      ? 403
      : status === 'invalid' || status === 'model-unavailable'
        ? 400
        : status === 'not-found'
          ? 404
          : status === 'conflict' || status === 'avatar-unavailable'
            ? 409
            : 503,
    { values, error: message, blocked: status === 'conflict' || status === 'unavailable' },
  );
}
export async function botVersionAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  botId: string,
  action: Action,
) {
  preventAuthenticationCaching(context.setHeaders);
  const invalid = (values: Record<string, string> = {}) =>
    actionFailure({ status: 'invalid' }, context, values);
  if (context.request.headers.get('origin') !== (process.env.WEB_ORIGIN ?? 'http://localhost:3000'))
    return actionFailure({ status: 'forbidden' }, context, {});
  const fields =
    action === 'restore'
      ? ['expectedCurrentVersionId', 'sourceVersionId', 'rationale']
      : [
          'expectedCurrentVersionId',
          'name',
          'roleDescription',
          'description',
          'instructions',
          'modelChoice',
          'rationale',
          ...Object.keys(versionLimitBounds),
        ];
  const values: Record<string, string> = {};
  let malformed = false;
  try {
    const form = await context.request.formData();
    for (const [key, value] of form) {
      if (!fields.includes(key) || typeof value !== 'string' || form.getAll(key).length !== 1)
        malformed = true;
      if (fields.includes(key) && typeof value === 'string') values[key] = value;
    }
  } catch {
    malformed = true;
  }
  if (
    malformed ||
    (action === 'edit' && values.modelChoice === undefined) ||
    !isBotUuid(values.expectedCurrentVersionId) ||
    (values.rationale?.length ?? 0) > 500
  )
    return invalid(values);
  const client = createBotVersionApiClient(context.fetch, context.request.signal),
    session = readSessionCookie(context.cookies);
  const expected = {
    expectedCurrentVersionId: values.expectedCurrentVersionId,
    ...(values.rationale === undefined ? {} : { rationale: values.rationale }),
  };
  let result;
  if (action === 'restore') {
    if (!isBotUuid(values.sourceVersionId)) return invalid(values);
    result = await client.restore(session, workspaceId, botId, {
      ...expected,
      sourceVersionId: values.sourceVersionId,
    });
  } else {
    const input: Record<string, unknown> = {};
    for (const field of ['name', 'roleDescription', 'description', 'instructions'])
      if (field in values) input[field] = values[field];
    if (values.modelChoice !== undefined && values.modelChoice !== 'keep') {
      try {
        input.modelBinding = JSON.parse(values.modelChoice);
      } catch {
        return invalid(values);
      }
    }
    const limits: Record<string, number> = {};
    for (const field of Object.keys(versionLimitBounds)) {
      if (!(field in values)) continue;
      if (!/^\d+$/u.test(values[field])) return invalid(values);
      limits[field] = Number(values[field]);
    }
    if (Object.keys(limits).length) input.limits = limits;
    const changes = parseBotVersionChanges(input, workspaceId);
    if (!changes) return invalid(values);
    result = await client.edit(session, workspaceId, botId, { ...expected, changes });
  }
  if (result.status !== 'available') return actionFailure(result, context, values);
  redirect(303, `/app/workspaces/${workspaceId.toLowerCase()}/bots/${botId.toLowerCase()}`);
}
