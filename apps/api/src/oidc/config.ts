import type { Environment } from '../config.js';
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  allowLoopbackHttp: boolean;
}
export function readOidcConfig(
  environment: Environment,
  webOrigin: string,
): OidcConfig | undefined {
  const issuer = environment.OIDC_ISSUER_URL;
  const clientId = environment.OIDC_CLIENT_ID;
  const clientSecret = environment.OIDC_CLIENT_SECRET;
  if (
    ![issuer, clientId, clientSecret, environment.OIDC_ALLOW_LOOPBACK_HTTP].some((value) =>
      Boolean(value?.trim()),
    )
  )
    return undefined;
  if (!issuer || !clientId?.trim() || !clientSecret?.trim())
    throw new Error('OIDC requires OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET');
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error('OIDC_ISSUER_URL must be a valid issuer URL');
  }
  const loopback = (hostname: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  const allowLoopbackHttp =
    environment.OIDC_ALLOW_LOOPBACK_HTTP === 'true' &&
    environment.NODE_ENV === 'test' &&
    loopback(new URL(webOrigin).hostname) &&
    loopback(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLoopbackHttp))
  )
    throw new Error('OIDC issuer must use HTTPS; loopback HTTP is restricted to tests');
  if (environment.OIDC_ALLOW_LOOPBACK_HTTP !== undefined && !allowLoopbackHttp)
    throw new Error('OIDC_ALLOW_LOOPBACK_HTTP is restricted to loopback tests');
  return {
    issuer,
    clientId,
    clientSecret,
    callbackUrl: `${webOrigin}/auth/oidc/callback`,
    allowLoopbackHttp,
  };
}
