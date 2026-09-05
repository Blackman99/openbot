import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createAuthApiClient } from './auth-api.js';
import { createWorkspaceApiClient } from './workspace-api.js';
import { createBotApiClient, isBotUuid, type BotScope, type BotInput } from './bot-api.js';
import { createProviderApiClient } from './provider-api.js';
import { createWorkspaceProviderApiClient } from './workspace-provider-api.js';
import { createCapabilityApiClient } from './capability-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
type PageContext = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
export interface BotModelChoice {
  scope: BotScope;
  connectionId: string;
  modelId: string;
  name: string;
  enabled: boolean;
  basic: boolean;
  collaboration: boolean;
  available: boolean;
}
function readFailure(status: string, cookies: PageContext['cookies']): never {
  if (status === 'anonymous') {
    clearSessionCookie(cookies);
    redirect(303, '/sign-in');
  }
  if (status === 'forbidden' || status === 'invalid')
    error(403, 'You cannot access this Bot or workspace');
  error(503, 'Bot service unavailable');
}
async function requireWorkspace(context: PageContext, workspaceId: string) {
  if (!isBotUuid(workspaceId)) error(403, 'You cannot access this workspace');
  const session = readSessionCookie(context.cookies);
  const identity = await createAuthApiClient(context.fetch).getIdentity(session);
  if (identity.status !== 'authenticated') readFailure(identity.status, context.cookies);
  const result = await createWorkspaceApiClient(context.fetch).list(session);
  if (result.status !== 'available') readFailure(result.status, context.cookies);
  const workspace = result.value.find(({ id }) => id === workspaceId.toLowerCase());
  if (!workspace) error(403, 'You cannot access this workspace');
  return { user: identity.identity.user, workspace, workspaces: result.value };
}
export async function loadBotModelChoices(
  context: PageContext,
  workspaceId: string,
  userId: string,
) {
  const session = readSessionCookie(context.cookies)!;
  let rejectedSession = false;
  // The personal provider client predates status/code matching. Track real HTTP 401s here.
  const request: typeof fetch = async (url, init) => {
    const response = await context.fetch(url, init);
    if (response.status === 401) rejectedSession = true;
    return response;
  };
  const [personal, shared] = await Promise.all([
    createProviderApiClient(request).list(session),
    createWorkspaceProviderApiClient(request).list(session, workspaceId),
  ]);
  if (rejectedSession) readFailure('anonymous', context.cookies);
  if (!shared.ok && shared.code === 'workspace_forbidden')
    readFailure('forbidden', context.cookies);
  const choices: BotModelChoice[] = [];
  if (personal.ok)
    for (const connection of personal.value)
      choices.push({
        scope: { kind: 'personal', id: userId },
        connectionId: connection.id,
        modelId: connection.modelId,
        name: connection.name,
        enabled: connection.enabled,
        available: false,
        basic: false,
        collaboration: false,
      });
  if (shared.ok)
    for (const connection of shared.value.connections)
      choices.push({
        scope: { kind: 'workspace', id: workspaceId },
        connectionId: connection.id,
        modelId: connection.modelId,
        name: connection.name,
        enabled: connection.availability === 'available',
        available: false,
        basic: false,
        collaboration: false,
      });
  const models: BotModelChoice[] = [];
  const seen = new Set<string>();
  let modelsUnavailable = !personal.ok || !shared.ok;
  for (const choice of choices) {
    if (
      !isBotUuid(choice.connectionId) ||
      !isBotUuid(choice.scope.id) ||
      !choice.modelId.trim() ||
      choice.modelId.length > 256
    ) {
      modelsUnavailable = true;
      continue;
    }
    const key = `${choice.scope.kind}:${choice.connectionId.toLowerCase()}`;
    if (seen.has(key)) {
      modelsUnavailable = true;
      continue;
    }
    seen.add(key);
    const result = await createCapabilityApiClient(request).get(
      session,
      choice.connectionId,
      choice.scope.kind === 'workspace' ? workspaceId : undefined,
    );
    if (rejectedSession) readFailure('anonymous', context.cookies);
    const consistent = result.ok && result.value.modelId === choice.modelId;
    models.push({
      ...choice,
      connectionId: choice.connectionId.toLowerCase(),
      scope: { ...choice.scope, id: choice.scope.id.toLowerCase() },
      enabled: consistent ? choice.enabled && result.value.enabled : choice.enabled,
      basic: consistent && result.value.basic,
      collaboration: consistent && result.value.collaboration,
      available: consistent,
    });
    if (!consistent) modelsUnavailable = true;
  }
  return { models, modelsUnavailable };
}
export async function loadBotsPage(context: PageContext, workspaceId: string) {
  preventAuthenticationCaching(context.setHeaders);
  const page = await requireWorkspace(context, workspaceId);
  const result = await createBotApiClient(context.fetch).list(
    readSessionCookie(context.cookies),
    page.workspace.id,
  );
  if (result.status !== 'available') readFailure(result.status, context.cookies);
  return {
    ...page,
    bots: result.value,
    ...(await loadBotModelChoices(context, page.workspace.id, page.user.id)),
  };
}
export async function loadBotPage(context: PageContext, workspaceId: string, botId: string) {
  preventAuthenticationCaching(context.setHeaders);
  const page = await requireWorkspace(context, workspaceId);
  const result = await createBotApiClient(context.fetch).get(
    readSessionCookie(context.cookies),
    page.workspace.id,
    botId,
  );
  if (result.status !== 'available') readFailure(result.status, context.cookies);
  return { ...page, bot: result.value };
}

const formFields = [
  'name',
  'roleDescription',
  'description',
  'instructions',
  'modelChoice',
  'maxTotalTokens',
  'maxDurationSeconds',
  'maxTurns',
  'maxDelegationDepth',
] as const;
function formValues(form: FormData): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  for (const key of formFields) {
    if (form.getAll(key).length > 1) return undefined;
    const value = form.get(key) ?? '';
    if (typeof value !== 'string') return undefined;
    values[key] = value;
  }
  return values;
}
function integerInput(value: string, fallback: number, min: number, max: number) {
  if (value === '') return fallback;
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}
function creationInput(values: Record<string, string>): BotInput | undefined {
  if (
    !values.name.trim() ||
    values.name.trim().length > 100 ||
    !values.roleDescription.trim() ||
    values.roleDescription.trim().length > 200 ||
    values.description.length > 2000 ||
    !values.instructions.trim() ||
    values.instructions.length > 32000
  )
    return undefined;
  const maxTotalTokens = integerInput(values.maxTotalTokens, 32768, 1, 1000000);
  const maxDurationSeconds = integerInput(values.maxDurationSeconds, 300, 1, 3600);
  const maxTurns = integerInput(values.maxTurns, 8, 1, 100);
  const maxDelegationDepth = integerInput(values.maxDelegationDepth, 2, 0, 8);
  if (
    maxTotalTokens === undefined ||
    maxDurationSeconds === undefined ||
    maxTurns === undefined ||
    maxDelegationDepth === undefined
  )
    return undefined;
  let binding: unknown;
  try {
    binding = JSON.parse(values.modelChoice);
  } catch {
    return undefined;
  }
  if (
    typeof binding !== 'object' ||
    binding === null ||
    Array.isArray(binding) ||
    Object.keys(binding).sort().join(',') !== 'connectionId,modelId,scope' ||
    !('connectionId' in binding) ||
    !isBotUuid(binding.connectionId) ||
    !('modelId' in binding) ||
    typeof binding.modelId !== 'string' ||
    !binding.modelId.trim() ||
    binding.modelId.length > 256 ||
    !('scope' in binding) ||
    typeof binding.scope !== 'object' ||
    binding.scope === null ||
    Array.isArray(binding.scope) ||
    Object.keys(binding.scope).sort().join(',') !== 'id,kind' ||
    !('kind' in binding.scope) ||
    (binding.scope.kind !== 'workspace' && binding.scope.kind !== 'personal') ||
    !('id' in binding.scope) ||
    !isBotUuid(binding.scope.id)
  )
    return undefined;
  return {
    name: values.name.trim(),
    roleDescription: values.roleDescription.trim(),
    description: values.description.trim(),
    instructions: values.instructions,
    modelBinding: {
      scope: { kind: binding.scope.kind, id: binding.scope.id.toLowerCase() },
      connectionId: binding.connectionId.toLowerCase(),
      modelId: binding.modelId,
    },
    limits: { maxTotalTokens, maxDurationSeconds, maxTurns, maxDelegationDepth },
  };
}
export async function createBotAction(
  context: PageContext & Pick<RequestEvent, 'request'>,
  workspaceId: string,
) {
  preventAuthenticationCaching(context.setHeaders);
  const values = formValues(await context.request.formData());
  const input = values && creationInput(values);
  if (!values || !input)
    return fail(400, {
      error: 'Check the field limits, provide system instructions, and select an available model.',
      values: values ?? {},
    });
  const page = await requireWorkspace(context, workspaceId);
  const binding = input.modelBinding;
  if (
    binding.scope.id !==
    (binding.scope.kind === 'workspace' ? page.workspace.id : page.user.id.toLowerCase())
  )
    return fail(400, {
      error: 'Select a personal model you own or a model in this workspace.',
      values,
    });
  const result = await createBotApiClient(context.fetch).create(
    readSessionCookie(context.cookies),
    page.workspace.id,
    input,
  );
  if (result.status === 'available')
    redirect(303, `/app/workspaces/${page.workspace.id}/bots/${result.value.id}`);
  if (result.status === 'anonymous') readFailure('anonymous', context.cookies);
  if (result.status === 'forbidden')
    return fail(403, {
      error: 'Your workspace access has changed. Reload to check your current access.',
      values,
    });
  if (result.status === 'invalid')
    return fail(400, {
      error: 'Check the field limits, instructions and selected model, then try again.',
      values,
    });
  if (result.status === 'model-unavailable') {
    const messages = {
      disabled:
        'The selected model is disabled. Enable it in model settings or choose another model.',
      'binding-changed':
        'The connection now uses a different model. Reload and select the current model.',
      'capability-unavailable':
        'The selected model needs verified text and streaming support. Review its capabilities or choose another model.',
      'not-accessible':
        'You cannot use the selected model. Choose an accessible personal or workspace model.',
    };
    return fail(400, { error: messages[result.reason], values });
  }
  error(503, 'Bot service unavailable');
}
