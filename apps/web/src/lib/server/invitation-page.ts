import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createInvitationApiClient, type InvitationResult } from './invitation-api.js';
import {
  preventAuthenticationCaching,
  readSessionCookie,
  clearSessionCookie,
  storeSessionCookie,
} from './session-cookie.js';
import { createAuthApiClient } from './auth-api.js';
import { createOidcApiClient } from './oidc-api.js';
import { loadWorkspacePage } from './workspace-page.js';

type PageContext = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
type ActionContext = PageContext & Pick<RequestEvent, 'request'>;
function invitationRateLimitMessage(
  result: { retryAfterSeconds?: number },
  setHeaders: PageContext['setHeaders'],
): string {
  if (result.retryAfterSeconds !== undefined) {
    setHeaders({ 'retry-after': String(result.retryAfterSeconds) });
    return `Too many invitation requests. Try again in ${result.retryAfterSeconds} seconds.`;
  }
  return 'Too many invitation requests. Try again later.';
}
function managementFailure(
  result: Exclude<InvitationResult<unknown>, { status: 'available' }>,
  action: string,
  setHeaders: PageContext['setHeaders'],
) {
  if (result.status === 'rate-limited')
    return fail(429, { action, error: invitationRateLimitMessage(result, setHeaders) });
  if (result.status === 'anonymous') redirect(303, '/sign-in');
  if (result.status === 'forbidden' || result.status === 'not-found')
    return fail(403, { action, error: 'You cannot manage invitations for this workspace.' });
  if (result.status === 'invalid')
    return fail(400, {
      action,
      error: 'Enter an email, a member or administrator role, and an expiry from 1 to 30 days.',
    });
  if (result.status === 'conflict')
    return fail(409, { action, error: 'This invitation is no longer available.' });
  error(503, 'Invitation service unavailable');
}
export async function createInvitationAction(
  { cookies, fetch, request, setHeaders, url }: ActionContext & Pick<RequestEvent, 'url'>,
  workspaceId: string,
) {
  preventAuthenticationCaching(setHeaders);
  const form = await request.formData();
  const role = form.get('role');
  const days = form.get('expiresInDays');
  if (
    (role !== 'member' && role !== 'administrator') ||
    typeof days !== 'string' ||
    !/^(?:[1-9]|[12][0-9]|30)$/u.test(days)
  )
    return managementFailure({ status: 'invalid' }, 'create', setHeaders);
  const result = await createInvitationApiClient(fetch).create(
    readSessionCookie(cookies),
    workspaceId,
    { email: String(form.get('email') ?? ''), role, expiresInDays: Number(days) },
  );
  if (result.status !== 'available') return managementFailure(result, 'create', setHeaders);
  return { action: 'create', invitationLink: `${url.origin}/join#token=${result.value.token}` };
}
export async function loadInvitationsPage(context: PageContext, workspaceId: string) {
  const page = await loadWorkspacePage(context, workspaceId);
  if (page.workspace.role === 'member')
    error(403, 'Only owners and administrators can manage invitations');
  const result = await createInvitationApiClient(context.fetch).list(
    readSessionCookie(context.cookies),
    workspaceId,
  );
  if (result.status === 'anonymous') redirect(303, '/sign-in');
  if (result.status === 'forbidden' || result.status === 'not-found')
    error(403, 'You cannot manage invitations for this workspace');
  if (result.status === 'rate-limited')
    error(429, invitationRateLimitMessage(result, context.setHeaders));
  if (result.status !== 'available') error(503, 'Invitation service unavailable');
  return { ...page, invitations: result.value };
}
export async function revokeInvitationAction(
  { cookies, fetch, request, setHeaders }: ActionContext,
  workspaceId: string,
) {
  preventAuthenticationCaching(setHeaders);
  const form = await request.formData();
  const invitationId = form.get('invitationId');
  if (typeof invitationId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(invitationId))
    return fail(400, { action: 'revoke', error: 'Select an invitation.' });
  const result = await createInvitationApiClient(fetch).revoke(
    readSessionCookie(cookies),
    workspaceId,
    invitationId,
  );
  if (result.status !== 'available') return managementFailure(result, 'revoke', setHeaders);
  return { action: 'revoke', revoked: true };
}
export async function acceptInvitationAction({
  cookies,
  fetch,
  request,
  setHeaders,
}: ActionContext) {
  preventAuthenticationCaching(setHeaders);
  const form = await request.formData();
  const session = readSessionCookie(cookies);
  const token = String(form.get('token') ?? '');
  const result = await createInvitationApiClient(fetch).accept(
    session,
    session
      ? { token }
      : {
          token,
          displayName: String(form.get('displayName') ?? ''),
          email: String(form.get('email') ?? ''),
          password: String(form.get('password') ?? ''),
        },
  );
  if (result.status === 'available') {
    if (result.value.cookie) storeSessionCookie(cookies, result.value.cookie);
    redirect(303, `/app/workspaces/${encodeURIComponent(result.value.identity.workspace.id)}`);
  }
  if (result.status === 'rate-limited')
    return fail(429, { error: invitationRateLimitMessage(result, setHeaders) });
  if (result.status === 'anonymous') {
    clearSessionCookie(cookies);
    return fail(401, { error: 'Your session expired. Sign in again to join.' });
  }
  if (result.status === 'invalid')
    return fail(400, {
      error: 'Enter your name, invited email address and a password of at least 12 characters.',
    });
  if (result.status === 'conflict')
    return fail(409, {
      error:
        'This invitation is unavailable for this account. Check the invited email, sign in if you already have an account, or ask an administrator for a new link.',
    });
  error(503, 'Invitation service unavailable');
}
export async function loadJoinPage({ cookies, fetch, setHeaders }: PageContext) {
  preventAuthenticationCaching(setHeaders);
  const result = await createAuthApiClient(fetch).getIdentity(readSessionCookie(cookies));
  if (result.status === 'unavailable') error(503, 'Authentication service unavailable');
  if (result.status === 'anonymous') {
    if (readSessionCookie(cookies)) clearSessionCookie(cookies);
    return { user: null, oidcEnabled: await createOidcApiClient(fetch).enabled() };
  }
  return { user: result.identity.user, oidcEnabled: false };
}
export async function signInForInvitationAction({
  cookies,
  fetch,
  request,
  setHeaders,
}: ActionContext) {
  preventAuthenticationCaching(setHeaders);
  const form = await request.formData();
  const result = await createAuthApiClient(fetch).signIn({
    email: String(form.get('email') ?? ''),
    password: String(form.get('password') ?? ''),
  });
  if (result.status === 'authenticated') {
    storeSessionCookie(cookies, result.cookie);
    return { signedIn: true };
  }
  if (result.status === 'invalid-credentials' || result.status === 'invalid-request')
    return fail(400, { error: 'Email or password is incorrect.' });
  if (result.status === 'rate-limited')
    return fail(429, { error: 'Too many sign-in attempts. Try again later.' });
  error(503, 'Authentication service unavailable');
}
