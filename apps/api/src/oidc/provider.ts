import * as client from 'openid-client';
import type { OidcConfig } from './config.js';
export interface OidcClaims {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
}
export interface OidcProof {
  state: string;
  nonce: string;
  verifier: string;
}
export interface OidcProvider {
  authorize(proof: OidcProof): Promise<string>;
  redeem(callbackUrl: string, proof: OidcProof): Promise<OidcClaims>;
}
export class OpenIdProvider implements OidcProvider {
  private configuration: Promise<client.Configuration> | undefined;
  constructor(private readonly options: OidcConfig) {}
  private assertEndpoint(target: URL): void {
    if (
      target.username ||
      target.password ||
      target.hash ||
      (target.protocol !== 'https:' &&
        !(
          this.options.allowLoopbackHttp &&
          target.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
        ))
    )
      throw new Error('Untrusted OIDC endpoint');
  }
  private getConfiguration(): Promise<client.Configuration> {
    this.configuration ??= client
      .discovery(
        new URL(this.options.issuer),
        this.options.clientId,
        this.options.clientSecret,
        undefined,
        {
          timeout: 5,
          execute: [
            client.enableNonRepudiationChecks,
            ...(this.options.allowLoopbackHttp ? [client.allowInsecureRequests] : []),
          ],
          [client.customFetch]: (url, options) => {
            this.assertEndpoint(new URL(String(url)));
            return fetch(url, {
              ...options,
              body:
                options.body instanceof Uint8Array
                  ? new Uint8Array(options.body)
                  : (options.body ?? null),
              redirect: 'error',
            });
          },
        },
      )
      .catch((error) => {
        this.configuration = undefined;
        throw error;
      });
    return this.configuration;
  }
  async authorize(proof: OidcProof): Promise<string> {
    const config = await this.getConfiguration();
    const authorization = client.buildAuthorizationUrl(config, {
      redirect_uri: this.options.callbackUrl,
      scope: 'openid email profile',
      response_type: 'code',
      code_challenge: await client.calculatePKCECodeChallenge(proof.verifier),
      code_challenge_method: 'S256',
      state: proof.state,
      nonce: proof.nonce,
    });
    this.assertEndpoint(authorization);
    return authorization.href;
  }
  async redeem(callbackUrl: string, proof: OidcProof): Promise<OidcClaims> {
    const callback = new URL(callbackUrl);
    if (
      callback.origin + callback.pathname !== this.options.callbackUrl ||
      callback.hash ||
      callback.username ||
      callback.password ||
      callback.searchParams.getAll('state').length !== 1 ||
      callback.searchParams.getAll('code').length !== 1
    )
      throw new Error('Invalid OIDC callback');
    const tokens = await client.authorizationCodeGrant(await this.getConfiguration(), callback, {
      expectedState: proof.state,
      expectedNonce: proof.nonce,
      pkceCodeVerifier: proof.verifier,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims || claims.iss !== this.options.issuer || !claims.sub)
      throw new Error('Invalid OIDC identity');
    return {
      issuer: claims.iss,
      subject: claims.sub,
      emailVerified: claims.email_verified === true,
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
      ...(typeof claims.name === 'string' ? { displayName: claims.name } : {}),
    };
  }
}
