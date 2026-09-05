import { error, fail, redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { createAuthApiClient } from '$lib/server/auth-api.js';
import { createProviderApiClient, type ProviderResult } from '$lib/server/provider-api.js';
import { preventAuthenticationCaching, readSessionCookie } from '$lib/server/session-cookie.js';
import type { Actions, PageServerLoad } from './$types';

const messages: Record<string, string> = {
  providers_not_configured: 'Ask the instance operator to configure the model encryption key.',
  provider_url_not_allowed: 'This endpoint is outside the instance network policy.',
  invalid_connection: 'Check the endpoint, model, and header fields.',
  connection_not_found: 'This connection is unavailable.',
  connection_conflict: 'The connection changed during testing. Reload and try again.',
  connection_disabled: 'This connection is disabled. Test and save to enable it.',
  provider_credentials_unavailable:
    'The saved credentials could not be opened. Contact the instance operator.',
};
function token(event: Pick<RequestEvent, 'cookies' | 'setHeaders'>): string {
  preventAuthenticationCaching(event.setHeaders);
  const value = readSessionCookie(event.cookies);
  if (!value) redirect(303, '/sign-in');
  return value;
}
function finish(result: ProviderResult<unknown>) {
  if (!result.ok) {
    if (result.code === 'authentication_required') redirect(303, '/sign-in');
    return fail(400, {
      error: messages[result.code] ?? 'The model service is unavailable. Try again.',
    });
  }
  return { success: 'Connection settings updated.' };
}
export const load: PageServerLoad = async (event) => {
  const session = token(event);
  const identity = await createAuthApiClient(event.fetch).getIdentity(session);
  if (identity.status === 'anonymous') redirect(303, '/sign-in');
  if (identity.status === 'unavailable') error(503, 'Authentication service unavailable');
  const result = await createProviderApiClient(event.fetch).list(session);
  if (!result.ok) {
    if (result.code === 'authentication_required') redirect(303, '/sign-in');
    error(503, messages[result.code] ?? 'Model settings unavailable');
  }
  return { connections: result.value };
};

export const actions = {
  save: async (event) => {
    const session = token(event);
    const form = await event.request.formData();
    const field = (name: string) => String(form.get(name) ?? '');
    const id = field('id');
    let headers: unknown;
    try {
      headers = field('headers').trim() ? JSON.parse(field('headers')) : undefined;
    } catch {
      return fail(400, { error: 'Custom headers must be a JSON object.' });
    }
    const input = {
      protocol: field('protocol') || 'openai-chat',
      name: field('name'),
      baseUrl: field('baseUrl'),
      modelId: field('modelId'),
      ...(!id || field('apiKey') || form.get('clearApiKey') === 'on'
        ? { apiKey: field('apiKey') }
        : {}),
      ...(!id || headers !== undefined ? { headers: headers ?? {} } : {}),
    };
    const client = createProviderApiClient(event.fetch);
    return finish(id ? await client.update(session, id, input) : await client.save(session, input));
  },
  disable: async (event) => {
    const session = token(event);
    return finish(
      await createProviderApiClient(event.fetch).disable(
        session,
        String((await event.request.formData()).get('id') ?? ''),
      ),
    );
  },
  delete: async (event) => {
    const session = token(event);
    return finish(
      await createProviderApiClient(event.fetch).delete(
        session,
        String((await event.request.formData()).get('id') ?? ''),
      ),
    );
  },
  test: async (event) => {
    const session = token(event);
    return finish(
      await createProviderApiClient(event.fetch).test(
        session,
        String((await event.request.formData()).get('id') ?? ''),
      ),
    );
  },
} satisfies Actions;
