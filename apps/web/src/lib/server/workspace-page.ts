import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';

import { createAuthApiClient } from './auth-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
import { createWorkspaceApiClient } from './workspace-api.js';

type PageContext = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;

export async function signOutAction({ cookies, fetch, setHeaders }: PageContext) {
  preventAuthenticationCaching(setHeaders);
  const result = await createAuthApiClient(fetch).signOut(readSessionCookie(cookies));
  if (result.status === 'unavailable') error(503, 'Authentication service unavailable');
  clearSessionCookie(cookies);
  redirect(303, '/sign-in');
}

export async function loadWorkspacePage(
  { cookies, fetch, setHeaders }: PageContext,
  selectedId?: string,
) {
  preventAuthenticationCaching(setHeaders);
  const auth = createAuthApiClient(fetch);
  const sessionToken = readSessionCookie(cookies);
  const identity = await auth.getIdentity(sessionToken);
  if (identity.status === 'unavailable') error(503, 'Authentication service unavailable');
  if (identity.status === 'anonymous') {
    if (sessionToken) clearSessionCookie(cookies);
    const state = await auth.getClaimState();
    if (state.status === 'unavailable') error(503, 'Authentication service unavailable');
    redirect(303, state.claimed ? '/sign-in' : '/setup');
  }
  const result = await createWorkspaceApiClient(fetch).list(sessionToken);
  if (result.status === 'anonymous') {
    clearSessionCookie(cookies);
    redirect(303, '/sign-in');
  }
  if (result.status !== 'available') error(503, 'Workspace service unavailable');
  const workspace = result.value.find(({ id }) => id === selectedId);
  if (!workspace) {
    const fallback = result.value[0];
    if (!fallback) error(403, 'No accessible workspace');
    redirect(303, `/app/workspaces/${encodeURIComponent(fallback.id)}`);
  }
  return { user: identity.identity.user, workspace, workspaces: result.value };
}

export async function createWorkspaceAction({
  cookies,
  fetch,
  request,
  setHeaders,
}: Pick<RequestEvent, 'cookies' | 'fetch' | 'request' | 'setHeaders'>) {
  preventAuthenticationCaching(setHeaders);
  const form = await request.formData();
  const input = {
    name: String(form.get('name') ?? ''),
    description: String(form.get('description') ?? ''),
  };
  const result = await createWorkspaceApiClient(fetch).create(readSessionCookie(cookies), input);
  if (result.status === 'anonymous') {
    clearSessionCookie(cookies);
    redirect(303, '/sign-in');
  }
  if (result.status === 'invalid')
    return fail(400, {
      action: 'create',
      error: 'Use a name of 1–100 characters and a description of up to 2,000 characters.',
    });
  if (result.status !== 'available') error(503, 'Workspace service unavailable');
  redirect(303, `/app/workspaces/${encodeURIComponent(result.value.id)}`);
}

export async function updateWorkspaceAction(
  {
    cookies,
    fetch,
    request,
    setHeaders,
  }: Pick<RequestEvent, 'cookies' | 'fetch' | 'request' | 'setHeaders'>,
  workspaceId: string,
) {
  preventAuthenticationCaching(setHeaders);
  const form = await request.formData();
  const input = {
    name: String(form.get('name') ?? ''),
    description: String(form.get('description') ?? ''),
  };
  const result = await createWorkspaceApiClient(fetch).update(
    readSessionCookie(cookies),
    workspaceId,
    input,
  );
  if (result.status === 'anonymous') {
    clearSessionCookie(cookies);
    redirect(303, '/sign-in');
  }
  if (result.status === 'not-found')
    return fail(403, { action: 'update', error: 'You cannot edit this workspace.' });
  if (result.status === 'invalid')
    return fail(400, {
      action: 'update',
      error: 'Use a name of 1–100 characters and a description of up to 2,000 characters.',
    });
  if (result.status !== 'available') error(503, 'Workspace service unavailable');
  return { action: 'update', saved: true };
}
