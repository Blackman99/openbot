import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createTeamTemplateApiClient, parseTeamTemplate } from './team-template-api.js';
import { loadBotsPage } from './bot-page.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';

type Context = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;

export type TeamImportValues = {
  template: string;
  acknowledgements: string[];
  modelBindings: Record<string, string>;
};

function anonymous(context: Context): never {
  clearSessionCookie(context.cookies);
  redirect(303, '/sign-in');
}

function formValues(input: Record<string, string | string[]>): TeamImportValues {
  const modelBindings: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith('modelBinding.') && typeof value === 'string')
      modelBindings[key.slice('modelBinding.'.length)] = value;
  }
  const acknowledgements = Array.isArray(input.acknowledgements)
    ? input.acknowledgements
    : typeof input.acknowledgements === 'string' && input.acknowledgements
      ? [input.acknowledgements]
      : Object.entries(input)
          .filter(([key, value]) => key.startsWith('ack.') && value === 'on')
          .map(([key]) => key.slice(4));
  return {
    template: typeof input.template === 'string' ? input.template : '',
    acknowledgements,
    modelBindings,
  };
}

export async function loadTeamImportPage(context: Context, workspaceId: string) {
  return loadBotsPage(context, workspaceId);
}

export async function teamImportAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  const form = await context.request.formData();
  const raw: Record<string, string | string[]> = {};
  for (const [key, value] of form) {
    if (typeof value !== 'string') continue;
    const current = raw[key];
    if (current === undefined) raw[key] = value;
    else raw[key] = [...(Array.isArray(current) ? current : [current]), value];
  }
  const values = formValues(raw);
  if (context.request.headers.get('origin') !== (process.env.WEB_ORIGIN ?? 'http://localhost:3000'))
    return fail(403, {
      values,
      error: 'You cannot import a team template from this origin.',
    });
  const session = readSessionCookie(context.cookies);
  if (!session) anonymous(context);
  let template: unknown;
  try {
    template = JSON.parse(values.template);
  } catch {
    return fail(400, { values, error: 'Paste a valid team template JSON document.' });
  }
  if (!parseTeamTemplate(template))
    return fail(400, {
      values,
      error: 'Review the template. Unsupported, secret, or malformed fields are rejected.',
    });
  const modelBindings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values.modelBindings)) {
    if (!value) continue;
    try {
      modelBindings[key] = JSON.parse(value);
    } catch {
      return fail(400, {
        values,
        error: 'Bind a compatible connection and model for every Bot.',
      });
    }
  }
  const client = createTeamTemplateApiClient(context.fetch);
  if (raw.intent === 'preview') {
    const result = await client.preview(session, workspaceId, {
      template,
      ...(Object.keys(modelBindings).length ? { modelBindings } : {}),
      acknowledgements: values.acknowledgements,
    });
    if (result.status === 'anonymous') anonymous(context);
    if (result.status !== 'available')
      return fail(400, {
        values,
        error: 'Review the template. Unsupported, secret, or malformed fields are rejected.',
        ...(result.status === 'invalid' && result.fields ? { fields: result.fields } : {}),
      });
    return { values, preview: result.value };
  }
  const imported = await client.import(session, workspaceId, {
    template,
    modelBindings,
    acknowledgements: values.acknowledgements,
  });
  if (imported.status === 'anonymous') anonymous(context);
  if (imported.status !== 'available')
    return fail(400, {
      values,
      error:
        imported.status === 'invalid'
          ? 'Resolve every model mapping, permission acknowledgement and validation result before import.'
          : 'Team template import is unavailable.',
      ...(imported.status === 'invalid' && imported.fields ? { fields: imported.fields } : {}),
    });
  redirect(303, `/app/workspaces/${workspaceId}/groups/${imported.value.id}`);
}

export async function downloadTeamTemplate(context: Context, workspaceId: string, groupId: string) {
  const session = readSessionCookie(context.cookies);
  if (!session) anonymous(context);
  const result = await createTeamTemplateApiClient(context.fetch).export(
    session,
    workspaceId,
    groupId,
  );
  if (result.status === 'anonymous') anonymous(context);
  if (result.status === 'forbidden') error(403, 'You cannot export this team');
  if (result.status !== 'available') error(503, 'Team template export unavailable');
  return new Response(JSON.stringify({ template: result.value }, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="team-template.json"',
      'cache-control': 'private, no-store',
    },
  });
}
