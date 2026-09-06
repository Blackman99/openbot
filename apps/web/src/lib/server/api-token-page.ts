import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createApiTokenApiClient, type ApiTokenResult } from './api-token-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
import { loadWorkspacePage } from './workspace-page.js';
type PageContext = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
type ActionContext = PageContext & Pick<RequestEvent, 'request'>;
function managementFailure(
  result: Exclude<ApiTokenResult<unknown>, { status: 'available' }>,
  action: 'create' | 'revoke',
  cookies: PageContext['cookies'],
) {
  if (result.status === 'anonymous') {
    clearSessionCookie(cookies);
    redirect(303, '/sign-in');
  }
  if (result.status === 'forbidden')
    return fail(403, {
      action,
      error: 'You no longer have access to API tokens in this workspace.',
    });
  if (result.status === 'not-found')
    return fail(404, { action, error: 'This token is unavailable. Reload your token list.' });
  if (result.status === 'invalid')
    return fail(400, {
      action,
      error: 'Use a name of 1–100 characters, at least one scope, and an expiration of 1–365 days.',
    });
  error(503, 'API token service unavailable');
}
export async function loadApiTokensPage(context: PageContext, workspaceId: string) {
  const page = await loadWorkspacePage(context, workspaceId);
  const result = await createApiTokenApiClient(context.fetch).list(
    readSessionCookie(context.cookies),
    workspaceId,
  );
  if (result.status === 'anonymous') {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  if (result.status === 'forbidden' || result.status === 'not-found')
    error(403, 'You cannot access API tokens in this workspace');
  if (
    result.status !== 'available' ||
    result.value.tokens.some((token) => token.creatorUserId !== page.user.id)
  )
    error(503, 'API token service unavailable');
  return { ...page, ...result.value };
}
export async function createApiTokenAction(
  { cookies, fetch, request, setHeaders }: ActionContext,
  workspaceId: string,
) {
  preventAuthenticationCaching(setHeaders);
  const form = await request.formData();
  const name = form.get('name');
  const scopes = form.getAll('scope');
  const days = Number(form.get('expiresInDays'));
  if (
    typeof name !== 'string' ||
    scopes.some((scope) => typeof scope !== 'string') ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 365
  )
    return managementFailure({ status: 'invalid' }, 'create', cookies);
  const result = await createApiTokenApiClient(fetch).create(
    readSessionCookie(cookies),
    workspaceId,
    {
      name,
      scopes: scopes.filter((scope): scope is string => typeof scope === 'string'),
      expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    },
  );
  if (result.status !== 'available') return managementFailure(result, 'create', cookies);
  return {
    action: 'create' as const,
    secret: result.value.secret,
    message: 'Copy this token now. It will not be shown again.',
  };
}
export async function revokeApiTokenAction(
  { cookies, fetch, request, setHeaders }: ActionContext,
  workspaceId: string,
) {
  preventAuthenticationCaching(setHeaders);
  const tokenId = (await request.formData()).get('tokenId');
  if (typeof tokenId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(tokenId))
    return managementFailure({ status: 'invalid' }, 'revoke', cookies);
  const result = await createApiTokenApiClient(fetch).revoke(
    readSessionCookie(cookies),
    workspaceId,
    tokenId,
  );
  if (result.status !== 'available') return managementFailure(result, 'revoke', cookies);
  return { action: 'revoke' as const, message: 'Token revoked. It can no longer access the API.' };
}
