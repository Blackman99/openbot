import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { loadBotPage, requireWorkspace } from './bot-page.js';
import { createBotApiClient } from './bot-api.js';
import { createBotLifecycleApiClient, type BotLifecycleAction } from './bot-lifecycle-api.js';
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
  if (status === 'forbidden' || status === 'invalid')
    error(403, 'Current Bot ownership and workspace membership are required');
  error(503, 'Bot recovery is unavailable');
}
export async function loadBotLifecyclePage(context: Context, workspaceId: string, botId: string) {
  const page = await loadBotPage(context, workspaceId, botId);
  if (page.bot.accessRole !== 'owner') readFailure('forbidden', context);
  const result = await createBotLifecycleApiClient(context.fetch).get(
    readSessionCookie(context.cookies),
    page.workspace.id,
    page.bot.id,
  );
  if (result.status !== 'available') readFailure(result.status, context);
  return { ...page, bot: { id: page.bot.id, name: page.bot.name }, lifecycle: result.value };
}
export async function loadDeletedBotsPage(context: Context, workspaceId: string) {
  preventAuthenticationCaching(context.setHeaders);
  const page = await requireWorkspace(context, workspaceId);
  const result = await createBotApiClient(context.fetch).list(
    readSessionCookie(context.cookies),
    page.workspace.id,
    'deleted',
  );
  if (result.status !== 'available') readFailure(result.status, context);
  return { ...page, bots: result.value };
}
async function emptyForm(request: Request) {
  const advertised = request.headers.get('content-length');
  if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > 1024))
    return false;
  if (!request.body) return true;
  const reader = request.body.getReader();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (next.value.length > 0) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
  }
}
export async function botLifecycleAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  botId: string,
  action: BotLifecycleAction,
) {
  preventAuthenticationCaching(context.setHeaders);
  if (
    context.request.headers.get('origin') !==
    new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000').origin
  )
    return fail(403, { error: 'This request origin is not allowed.', uncertain: false });
  if (!(await emptyForm(context.request)))
    return fail(400, { error: 'Invalid Bot lifecycle request.', uncertain: false });
  const result = await createBotLifecycleApiClient(context.fetch, context.request.signal).change(
    readSessionCookie(context.cookies),
    workspaceId,
    botId,
    action,
  );
  if (result.status === 'anonymous') readFailure(result.status, context);
  if (result.status === 'available') {
    const messages = {
      archive: 'Bot archived. New work is blocked.',
      restore: 'Bot restored to active.',
      delete: 'Bot deleted. Recovery remains available until the recorded deadline.',
      'undo-delete': `Deletion undone. Bot is ${result.value.state}.`,
    };
    return { message: messages[action], lifecycle: result.value };
  }
  const errors: Record<string, [number, string]> = {
    forbidden: [403, 'Your current Bot ownership or workspace access does not allow this change.'],
    invalid: [400, 'Invalid Bot lifecycle request.'],
    conflict: [409, 'This Bot is deleted. Use Undo deletion during its recovery window.'],
    expired: [
      409,
      'The recovery deadline has passed. This Bot remains deleted; no physical erasure is performed.',
    ],
    'model-unavailable': [
      400,
      'The Bot cannot become active. Its exact model must be enabled, verified for Basic use, and accessible to you. Review the model connection, then retry.',
    ],
  };
  const known = errors[result.status];
  return fail(known?.[0] ?? 503, {
    error:
      known?.[1] ??
      'The result could not be confirmed. Refresh this page to inspect the current Bot state before trying again.',
    uncertain: !known,
  });
}
