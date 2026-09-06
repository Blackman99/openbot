import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createBotTemplateApiClient } from './bot-template-api.js';
import { loadBotModelChoices, loadBotsPage } from './bot-page.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';

type Context = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;

export type BotImportValues = {
  template: string;
  compareBotId: string;
  modelChoice: string;
};

function anonymous(context: Context): never {
  clearSessionCookie(context.cookies);
  redirect(303, '/sign-in');
}

function formValues(input: Record<string, string>): BotImportValues {
  return {
    template: input.template ?? '',
    compareBotId: input.compareBotId ?? '',
    modelChoice: input.modelChoice ?? '',
  };
}

export async function loadBotImportPage(context: Context, workspaceId: string) {
  const page = await loadBotsPage(context, workspaceId);
  return {
    ...page,
    ...(await loadBotModelChoices(context, page.workspace.id, page.user.id)),
  };
}

export async function botImportAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  const form = await context.request.formData();
  const raw: Record<string, string> = {};
  for (const [key, value] of form) {
    if (typeof value === 'string') raw[key] = value;
  }
  const values = formValues(raw);
  if (context.request.headers.get('origin') !== (process.env.WEB_ORIGIN ?? 'http://localhost:3000'))
    return fail(403, {
      values,
      error: 'You cannot import a Bot template from this origin.',
    });
  const session = readSessionCookie(context.cookies);
  if (!session) anonymous(context);
  let template: unknown;
  try {
    template = JSON.parse(values.template);
  } catch {
    return fail(400, { values, error: 'Paste a valid Bot template JSON document.' });
  }
  const client = createBotTemplateApiClient(context.fetch);
  if (raw.intent === 'preview') {
    const result = await client.preview(session, workspaceId, {
      template,
      ...(values.compareBotId ? { compareBotId: values.compareBotId } : {}),
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
  if (!values.modelChoice)
    return fail(400, {
      values,
      error: 'Bind a compatible connection and model before creating the Bot.',
    });
  let modelBinding: unknown;
  try {
    modelBinding = JSON.parse(values.modelChoice);
  } catch {
    return fail(400, {
      values,
      error: 'Bind a compatible connection and model before creating the Bot.',
    });
  }
  const imported = await client.import(session, workspaceId, { template, modelBinding });
  if (imported.status === 'anonymous') anonymous(context);
  if (imported.status !== 'available')
    return fail(400, {
      values,
      error:
        imported.status === 'invalid'
          ? 'The template or selected model was rejected. Bind a model that meets the required capabilities.'
          : 'Bot template import is unavailable.',
      ...(imported.status === 'invalid' && imported.fields ? { fields: imported.fields } : {}),
    });
  redirect(303, `/app/workspaces/${workspaceId}/bots/${imported.value.id}`);
}

export async function downloadBotTemplate(context: Context, workspaceId: string, botId: string) {
  const session = readSessionCookie(context.cookies);
  if (!session) anonymous(context);
  const result = await createBotTemplateApiClient(context.fetch).export(
    session,
    workspaceId,
    botId,
  );
  if (result.status === 'anonymous') anonymous(context);
  if (result.status === 'forbidden') error(403, 'You cannot export this Bot');
  if (result.status !== 'available') error(503, 'Bot template export unavailable');
  return new Response(JSON.stringify({ template: result.value }, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="bot-template.json"',
      'cache-control': 'private, no-store',
    },
  });
}
