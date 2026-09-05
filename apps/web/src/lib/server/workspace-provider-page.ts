import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createWorkspaceProviderApiClient } from './workspace-provider-api.js';
import type { ProviderResult } from './provider-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
import { loadWorkspacePage } from './workspace-page.js';
type PageContext = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
type ActionContext = PageContext & Pick<RequestEvent, 'request'>;

const failures: Record<string, { status: number; message: string }> = {
  workspace_forbidden: {
    status: 403,
    message: 'You do not have permission for this operation. Reload to see your current access.',
  },
  invalid_origin: {
    status: 403,
    message: 'This request could not be verified. Reload and try again.',
  },
  connection_not_found: {
    status: 404,
    message: 'This connection is unavailable. Reload the models list.',
  },
  connection_disabled: {
    status: 409,
    message:
      'This connection is unavailable because it is disabled. An owner or administrator can test and save to enable it.',
  },
  connection_conflict: {
    status: 409,
    message: 'The connection changed during testing. Reload and try again.',
  },
  invalid_connection: { status: 400, message: 'Check the endpoint, model, and header fields.' },
  provider_url_not_allowed: {
    status: 400,
    message: 'This endpoint is outside the instance network policy.',
  },
  providers_not_configured: {
    status: 503,
    message: 'Ask the instance operator to configure the model encryption key.',
  },
  provider_credentials_unavailable: {
    status: 503,
    message: 'The saved credentials could not be opened. Contact the instance operator.',
  },
};
function token(context: PageContext): string {
  preventAuthenticationCaching(context.setHeaders);
  const session = readSessionCookie(context.cookies);
  if (!session) redirect(303, '/sign-in');
  return session;
}
function finish(result: ProviderResult<unknown>, context: PageContext, success: string) {
  if (result.ok) return { success };
  if (result.code === 'authentication_required') {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  const failure = failures[result.code] ?? {
    status: 503,
    message: 'The model service is unavailable. Try again.',
  };
  return fail(failure.status, { error: failure.message });
}
export async function loadWorkspaceModelsPage(context: PageContext, workspaceId: string) {
  const page = await loadWorkspacePage(context, workspaceId);
  const result = await createWorkspaceProviderApiClient(context.fetch).list(
    readSessionCookie(context.cookies) ?? '',
    workspaceId,
  );
  if (!result.ok) {
    if (result.code === 'authentication_required') {
      clearSessionCookie(context.cookies);
      redirect(303, '/sign-in');
    }
    if (result.code === 'workspace_forbidden')
      error(403, 'You cannot access models in this workspace');
    error(503, 'Workspace models unavailable');
  }
  return { ...page, ...result.value };
}

export async function saveWorkspaceModelAction(context: ActionContext, workspaceId: string) {
  const session = token(context);
  const form = await context.request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  const id = field('id');
  let headers: unknown;
  try {
    headers = field('headers').trim() ? JSON.parse(field('headers')) : undefined;
  } catch {
    return fail(400, { error: 'Custom headers must be a JSON object.' });
  }
  const protocol = field('protocol') || 'openai-chat';
  const input = {
    protocol,
    ...(protocol === 'anthropic-messages'
      ? { anthropicVersion: field('anthropicVersion') || '2023-06-01' }
      : {}),
    name: field('name'),
    baseUrl: field('baseUrl'),
    modelId: field('modelId'),
    ...(!id || field('apiKey') || form.get('clearApiKey') === 'on'
      ? { apiKey: field('apiKey') }
      : {}),
    ...(!id || headers !== undefined ? { headers: headers ?? {} } : {}),
  };
  const client = createWorkspaceProviderApiClient(context.fetch);
  return finish(
    id
      ? await client.update(session, workspaceId, id, input)
      : await client.save(session, workspaceId, input),
    context,
    'Workspace connection saved.',
  );
}

export async function testWorkspaceModelAction(context: ActionContext, workspaceId: string) {
  const session = token(context);
  const id = String((await context.request.formData()).get('id') ?? '');
  return finish(
    await createWorkspaceProviderApiClient(context.fetch).test(session, workspaceId, id),
    context,
    'Connection test completed.',
  );
}

export async function disableWorkspaceModelAction(context: ActionContext, workspaceId: string) {
  const session = token(context);
  const id = String((await context.request.formData()).get('id') ?? '');
  return finish(
    await createWorkspaceProviderApiClient(context.fetch).disable(session, workspaceId, id),
    context,
    'Workspace connection disabled.',
  );
}
