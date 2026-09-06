import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import {
  capabilityFlags,
  type CapabilityCatalog,
  type ModelChoice,
  type ResolutionPreview,
} from '../capability-types.js';
import { createCapabilityApiClient } from './capability-api.js';
import { requirement } from './capability-contract.js';
import { createProviderApiClient, type ProviderResult } from './provider-api.js';
import { createWorkspaceProviderApiClient } from './workspace-provider-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
type PageContext = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
type ActionContext = PageContext & Pick<RequestEvent, 'request'>;
export interface CapabilityPageData {
  catalog: CapabilityCatalog;
  choices: ModelChoice[];
  preview: ResolutionPreview;
  backHref: string;
  workspaceId?: string;
}
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
    message: 'This connection is unavailable. Return to the models list.',
  },
  connection_disabled: {
    status: 409,
    message:
      'This connection is disabled. Test and save its settings to enable it before re-probing.',
  },
  connection_conflict: {
    status: 409,
    message: 'This connection changed. Reload the page before making another change.',
  },
  invalid_connection: {
    status: 400,
    message: 'The saved connection settings are invalid. Check the model settings.',
  },
  invalid_capability_policy: {
    status: 400,
    message: 'Check the capability, rationale, revision, and fallback selections.',
  },
  duplicate_fallback: { status: 400, message: 'Each fallback must be a different model.' },
  fallback_cycle: {
    status: 400,
    message: 'This fallback chain would create a cycle. Choose another model.',
  },
  fallback_unavailable: {
    status: 400,
    message: 'Choose enabled, accessible fallback models in the same scope.',
  },
  fallback_capability_required: {
    status: 400,
    message: 'Every fallback must support the required capability.',
  },
  providers_not_configured: {
    status: 503,
    message: 'Ask the instance operator to configure the model encryption key.',
  },
  provider_credentials_unavailable: {
    status: 503,
    message: 'The saved credentials could not be opened. Contact the instance operator.',
  },
  provider_url_not_allowed: {
    status: 400,
    message: 'This endpoint is outside the instance network policy.',
  },
};
function session(context: PageContext): string {
  preventAuthenticationCaching(context.setHeaders);
  const token = readSessionCookie(context.cookies);
  if (!token) redirect(303, '/sign-in');
  return token;
}
function failure(code: string, context: PageContext) {
  if (code === 'authentication_required') {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  return failures[code] ?? { status: 503, message: 'The model service is unavailable. Try again.' };
}
function loaded<T>(result: ProviderResult<T>, context: PageContext): T {
  if (result.ok) return result.value;
  const detail = failure(result.code, context);
  error(detail.status, detail.message);
}
export async function loadCapabilitiesPage(
  context: PageContext & Pick<RequestEvent, 'url'>,
  id: string,
  workspaceId?: string,
): Promise<CapabilityPageData> {
  const token = session(context);
  const client = createCapabilityApiClient(context.fetch);
  const catalog = loaded(await client.get(token, id, workspaceId), context);
  const requested = context.url.searchParams.get('capability');
  const capability = requirement(requested) ? requested : catalog.fallbacks.requiredCapability;
  const choicesRequest =
    workspaceId === undefined
      ? createProviderApiClient(context.fetch)
          .list(token)
          .then((result) =>
            loaded(result, context).map(({ id, name, enabled }) => ({ id, name, enabled })),
          )
      : createWorkspaceProviderApiClient(context.fetch)
          .list(token, workspaceId)
          .then((result) =>
            loaded(result, context).connections.map(({ id, name, availability }) => ({
              id,
              name,
              enabled: availability === 'available',
            })),
          );
  const [choices, preview] = await Promise.all([
    choicesRequest,
    client.preview(token, id, capability, workspaceId).then((result) => loaded(result, context)),
  ]);
  return {
    catalog,
    choices,
    preview,
    backHref:
      workspaceId === undefined
        ? '/app/settings/models'
        : `/app/workspaces/${encodeURIComponent(workspaceId)}/models`,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
}
export async function capabilityAction(
  context: ActionContext,
  id: string,
  action: 'override' | 'fallbacks' | 'reprobe',
  workspaceId?: string,
) {
  const token = session(context);
  const form = await context.request.formData();
  const field = (name: string) =>
    typeof form.get(name) === 'string' ? String(form.get(name)) : '';
  const revision = field('expectedRevision');
  const expectedRevision = Number(revision);
  const invalid = () => fail(400, { error: failures.invalid_capability_policy.message });
  if (!/^\d+$/u.test(revision) || !Number.isSafeInteger(expectedRevision)) return invalid();
  const client = createCapabilityApiClient(context.fetch);
  let result: ProviderResult<CapabilityCatalog>;
  if (action === 'override') {
    const capability = field('capability');
    const rationale = field('rationale').trim();
    const value = field('value');
    if (
      !capabilityFlags.some((flag) => flag === capability) ||
      !rationale ||
      rationale.length > 500 ||
      (value !== 'true' && value !== 'false')
    )
      return invalid();
    result = await client.override(
      token,
      id,
      { expectedRevision, capability, value: value === 'true', rationale },
      workspaceId,
    );
  } else if (action === 'fallbacks') {
    const requiredCapability = field('requiredCapability');
    const connectionIds = form
      .getAll('connectionIds')
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    if (!requirement(requiredCapability) || connectionIds.length > 16) return invalid();
    result = await client.fallbacks(
      token,
      id,
      { expectedRevision, requiredCapability, connectionIds },
      workspaceId,
    );
  } else result = await client.reprobe(token, id, expectedRevision, workspaceId);
  if (!result.ok) {
    const detail = failure(result.code, context);
    return fail(detail.status, {
      error: detail.message,
      reloadRequired: result.code === 'connection_conflict',
    });
  }
  return {
    success:
      action === 'override'
        ? 'Manual override saved.'
        : action === 'fallbacks'
          ? 'Fallback order saved.'
          : 'Capabilities re-probed.',
  };
}
