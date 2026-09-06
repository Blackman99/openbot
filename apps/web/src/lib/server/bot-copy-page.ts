import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { isBotUuid } from './bot-api.js';
import { loadBotModelChoices, loadBotPage } from './bot-page.js';
import { createBotCopyApiClient, type BotCopyRequest } from './bot-copy-api.js';
import { parseBotVersionChanges, type BotVersionResult } from './bot-version-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
type Context = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
function anonymous(context: Context): never {
  clearSessionCookie(context.cookies);
  redirect(303, '/sign-in');
}
export async function loadBotCopyPage(context: Context, workspaceId: string, botId: string) {
  const page = await loadBotPage(context, workspaceId, botId);
  const result = await createBotCopyApiClient(context.fetch).preview(
    readSessionCookie(context.cookies),
    workspaceId,
    botId,
  );
  if (result.status === 'anonymous') anonymous(context);
  if (result.status === 'forbidden') error(403, 'You cannot copy this Bot');
  if (result.status === 'invalid') error(400, 'Invalid Bot copy request');
  if (result.status !== 'available') error(503, 'Bot copy preview unavailable');
  return {
    ...page,
    preview: result.value,
    ...(await loadBotModelChoices(context, page.workspace.id, page.user.id)),
  };
}
function actionFailure(
  result: Exclude<BotVersionResult<unknown>, { status: 'available' }>,
  context: Context,
  values: Record<string, string>,
) {
  if (result.status === 'anonymous') anonymous(context);
  const status = result.status;
  const message =
    status === 'forbidden'
      ? 'You no longer have permission to copy this Bot. Reload to check access.'
      : status === 'invalid'
        ? 'Review the source version and select a model before confirming.'
        : status === 'conflict'
          ? 'The source Bot changed. Reload the preview and review it before confirming another copy.'
          : status === 'avatar-unavailable'
            ? 'The source avatar is unavailable. Reload the preview after the image is available.'
            : status === 'model-unavailable'
              ? 'You cannot currently use the selected model. Select an accessible, enabled model with verified Basic capability.'
              : 'We could not confirm this copy. Check your Bots for a newly created copy before submitting again.';
  return fail(
    status === 'forbidden'
      ? 403
      : status === 'invalid' || status === 'model-unavailable'
        ? 400
        : status === 'conflict' || status === 'avatar-unavailable'
          ? 409
          : 503,
    {
      values,
      error: message,
      blocked: status === 'conflict' || status === 'unavailable' || status === 'avatar-unavailable',
    },
  );
}
export async function botCopyAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  botId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  if (context.request.headers.get('origin') !== (process.env.WEB_ORIGIN ?? 'http://localhost:3000'))
    return actionFailure({ status: 'forbidden' }, context, {});
  const values: Record<string, string> = {};
  const invalid = () => actionFailure({ status: 'invalid' }, context, values);
  try {
    const form = await context.request.formData();
    for (const [key, value] of form) {
      if (
        !['expectedCurrentVersionId', 'modelChoice'].includes(key) ||
        typeof value !== 'string' ||
        form.getAll(key).length !== 1
      )
        return invalid();
      values[key] = value;
    }
  } catch {
    return invalid();
  }
  if (!isBotUuid(values.expectedCurrentVersionId) || !values.modelChoice) return invalid();
  const input: BotCopyRequest = { expectedCurrentVersionId: values.expectedCurrentVersionId };
  if (values.modelChoice !== 'keep') {
    try {
      const parsed = parseBotVersionChanges(
        { modelBinding: JSON.parse(values.modelChoice) },
        workspaceId,
      );
      if (!parsed?.modelBinding) return invalid();
      input.modelBinding = parsed.modelBinding;
    } catch {
      return invalid();
    }
  }
  const result = await createBotCopyApiClient(context.fetch, context.request.signal).confirm(
    readSessionCookie(context.cookies),
    workspaceId,
    botId,
    input,
  );
  if (result.status !== 'available') return actionFailure(result, context, values);
  redirect(303, `/app/workspaces/${result.value.workspaceId}/bots/${result.value.id}`);
}
