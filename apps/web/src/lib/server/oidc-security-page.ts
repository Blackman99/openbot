import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createAuthApiClient } from './auth-api.js';
import { createOidcApiClient } from './oidc-api.js';
import { oidcErrorMessage } from './oidc-errors.js';
import { trustedOidcOrigin } from './oidc-flow.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';

type PageContext = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders' | 'url'>;
export async function loadSecurityPage({ cookies, fetch, setHeaders, url }: PageContext) {
  preventAuthenticationCaching(setHeaders);
  const session = readSessionCookie(cookies);
  const identity = await createAuthApiClient(fetch).getIdentity(session);
  if (identity.status === 'anonymous') {
    if (session) clearSessionCookie(cookies);
    redirect(303, '/sign-in');
  }
  if (identity.status !== 'authenticated') error(503, 'Authentication service unavailable');
  const oidc = createOidcApiClient(fetch);
  const oidcEnabled = await oidc.enabled();
  const page = {
    user: identity.identity.user,
    oidcEnabled,
    linked: false,
    canUnlink: false,
    oidcError: oidcErrorMessage(url.searchParams.get('oidcError')),
  };
  if (!oidcEnabled) return page;
  const result = await oidc.identity(session);
  if (result.status === 'failed') {
    if (result.code === 'authentication_required') {
      clearSessionCookie(cookies);
      redirect(303, '/sign-in');
    }
    error(503, 'OIDC identity service unavailable');
  }
  return { ...page, ...result.value };
}
export async function unlinkOidcAction({
  cookies,
  fetch,
  setHeaders,
  request,
  url,
}: PageContext & Pick<RequestEvent, 'request'>) {
  preventAuthenticationCaching(setHeaders);
  const origin = trustedOidcOrigin();
  if (request.headers.get('origin') !== origin || url.origin !== origin)
    return fail(403, { error: 'Reload this page before trying again.' });
  const session = readSessionCookie(cookies);
  if (!session) redirect(303, '/sign-in');
  const result = await createOidcApiClient(fetch).unlink(session);
  if (result.status === 'available') return { unlinked: true };
  if (result.code === 'authentication_required') {
    clearSessionCookie(cookies);
    redirect(303, '/sign-in');
  }
  return fail(result.code === 'provider_unavailable' ? 503 : 409, {
    error: oidcErrorMessage(result.code),
  });
}
