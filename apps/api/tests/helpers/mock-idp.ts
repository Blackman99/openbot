import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
export type MockClaims = Record<string, unknown>;
export async function startMockIdp(metadata: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { challenge: string; nonce: string; redirectUri: string; claims: MockClaims }
  >();
  let issuer = '';
  let nextClaims: MockClaims = {};
  let invalidSignature = false;
  let redemptionCount = 0;
  function issue(authorization: URL, claims: MockClaims = {}) {
    if (
      authorization.searchParams.get('response_type') !== 'code' ||
      authorization.searchParams.get('code_challenge_method') !== 'S256'
    )
      throw new Error('Invalid authorization request');
    const code = randomBytes(24).toString('base64url');
    const redirectUri = authorization.searchParams.get('redirect_uri')!;
    codes.set(code, {
      challenge: authorization.searchParams.get('code_challenge')!,
      nonce: authorization.searchParams.get('nonce')!,
      redirectUri,
      claims,
    });
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    return callback.href;
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, issuer);
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        ...metadata,
      });
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      if (url.searchParams.get('confirm') === 'yes') {
        const location = issue(url, nextClaims);
        nextClaims = {};
        response.writeHead(302, { location });
        return response.end();
      }
      const escape = (value: string) =>
        value.replace(
          /[&<>"']/gu,
          (char) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
        );
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(
        `<h1>Mock identity provider</h1><form method="GET" action="/authorize">${[...url.searchParams].map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join('')}<input type="hidden" name="confirm" value="yes"><button>Continue as test identity</button></form>`,
      );
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      redemptionCount++;
      let body = '';
      for await (const chunk of request) body += chunk;
      const form = new URLSearchParams(body);
      const grant = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (
        !grant ||
        form.get('client_id') !== 'openbot' ||
        form.get('client_secret') !== 'test-secret' ||
        form.get('redirect_uri') !== grant.redirectUri ||
        createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url') !== grant.challenge
      )
        return json(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: issuer,
        sub: 'ada-subject',
        aud: 'openbot',
        iat: now,
        exp: now + 300,
        nonce: grant.nonce,
        email: 'ada@example.com',
        email_verified: true,
        name: 'Ada',
        ...grant.claims,
      };
      const input = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
      const signature = invalidSignature
        ? Buffer.alloc(256).toString('base64url')
        : sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
      return json(200, {
        access_token: 'test-access-token',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: `${input}.${signature}`,
      });
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    issue: (url: string, claims: MockClaims = {}) => issue(new URL(url), claims),
    setClaims: (claims: MockClaims) => {
      nextClaims = claims;
    },
    breakSignature: () => {
      invalidSignature = true;
    },
    get redemptionCount() {
      return redemptionCount;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
