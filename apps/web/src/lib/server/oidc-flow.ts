import { redirect, type RequestEvent } from '@sveltejs/kit';
import {
  createOidcApiClient,
  OIDC_COOKIE_NAME,
  OIDC_COOKIE_PATH,
  type OidcErrorCode,
} from './oidc-api.js';
import {
  preventAuthenticationCaching,
  readSessionCookie,
  storeSessionCookie,
} from './session-cookie.js';

type FlowContext = Pick<RequestEvent, 'url' | 'request' | 'cookies' | 'fetch' | 'setHeaders'>;
export function trustedOidcOrigin(): string {
  return new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000').origin;
}
export function oidcFailureRedirect(code: OidcErrorCode): never {
  redirect(303, `/sign-in?oidcError=${code}`);
}
function protect(context: FlowContext): void {
  preventAuthenticationCaching(context.setHeaders);
  context.setHeaders({ 'referrer-policy': 'no-referrer' });
}
export async function startOidc(context: FlowContext): Promise<Response> {
  protect(context);
  const { request, cookies, fetch, url } = context;
  const origin = trustedOidcOrigin();
  if (url.origin !== origin || request.headers.get('origin') !== origin)
    oidcFailureRedirect('invalid_flow');
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    oidcFailureRedirect('invalid_flow');
  }
  const purpose = form.get('purpose');
  if (purpose !== 'signin' && purpose !== 'link' && purpose !== 'invite')
    oidcFailureRedirect('invalid_flow');
  const invitationToken = form.get('invitationToken');
  if (
    purpose === 'invite' &&
    (typeof invitationToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(invitationToken))
  )
    oidcFailureRedirect('invalid_flow');
  const result = await createOidcApiClient(fetch).start(
    {
      purpose,
      ...(purpose === 'invite' && typeof invitationToken === 'string' ? { invitationToken } : {}),
    },
    readSessionCookie(cookies),
  );
  if (result.status === 'failed') oidcFailureRedirect(result.code);
  const { cookie, authorizationUrl } = result.value;
  cookies.set(OIDC_COOKIE_NAME, cookie.value, {
    expires: cookie.expires,
    httpOnly: true,
    path: OIDC_COOKIE_PATH,
    sameSite: 'lax',
    secure: cookie.secure,
  });
  redirect(303, authorizationUrl);
}
export async function completeOidc(context: FlowContext): Promise<Response> {
  protect(context);
  const { cookies, fetch, url } = context;
  const origin = trustedOidcOrigin();
  const token = cookies.get(OIDC_COOKIE_NAME);
  cookies.delete(OIDC_COOKIE_NAME, {
    path: OIDC_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(origin).protocol === 'https:',
  });
  if (
    url.origin !== origin ||
    url.pathname !== '/auth/oidc/callback' ||
    url.hash ||
    url.username ||
    url.password ||
    !token ||
    !/^[A-Za-z0-9_-]{43}$/u.test(token)
  )
    oidcFailureRedirect('invalid_flow');
  const result = await createOidcApiClient(fetch).callback(
    url.href,
    token,
    readSessionCookie(cookies),
  );
  if (result.status === 'failed') oidcFailureRedirect(result.code);
  if (result.value.cookie) storeSessionCookie(cookies, result.value.cookie);
  redirect(303, result.value.destination);
}
