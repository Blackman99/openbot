# AUTH-02 implementation handoff

Prepared on2026-09-05 from primary package metadata and upstream documentation. This is preparatory research; AUTH-02 remains blocked until WS-02 is integrated.

## Library and protocol

- Candidate: `openid-client@6.8.7`, compatible with Node24 and this ESM/TypeScript project. Verify the pin when installing. Sources: [registry](https://registry.npmjs.org/openid-client/latest), [upstream package](https://github.com/panva/openid-client/blob/v6.8.7/package.json), [runtime requirements](https://github.com/panva/openid-client/tree/v6.8.7#supported-runtimes).
- Use issuer-URL discovery, Authorization Code, S256 PKCE, random state and nonce, and fixed callback URLs. Pass `expectedState`, `expectedNonce`, `pkceCodeVerifier`, and `idTokenExpected` to the grant. Sources: [discovery](https://github.com/panva/openid-client/blob/v6.8.7/docs/functions/discovery.md), [grant checks](https://github.com/panva/openid-client/blob/v6.8.7/docs/interfaces/AuthorizationCodeGrantChecks.md).
- Explicitly enable [non-repudiation checks](https://github.com/panva/openid-client/blob/v6.8.7/docs/functions/enableNonRepudiationChecks.md) so ID-token signatures are verified against JWKS. Do not rely solely on TLS for the token endpoint response.
- Production issuer/token/JWKS traffic requires HTTPS. A narrowly scoped loopback HTTP exception is only for the test IdP.

## Application transaction boundaries

- Persist short-lived browser-bound login transactions with purpose (`signin`, `link`, or `invite`), state, nonce, PKCE verifier, initiating identity/session, and expiry. Atomically consume each transaction; callbacks must not be replayable across requests or browsers.
- Stable external identity is `(issuer, subject)`, never email. A matching existing local email requires explicit linking after local sign-in, not automatic account reuse. [OIDC claim stability](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability).
- Linking must revalidate the initiating authenticated session at callback time. Unlinking cannot remove the last usable authentication method.
- An invitation-based OIDC registration must atomically consume the invitation, create the account without a local password, link the external identity, add membership, issue a session, and append audits. Email-targeted invitations require a verified, matching email. If UserInfo supplies claims, validate its subject against the ID token. [UserInfo validation](https://github.com/panva/openid-client/blob/v6.8.7/docs/functions/fetchUserInfo.md).

## Existing-code seams

- Session creation currently labels audits `local`; add an explicit authentication-method input for OIDC.
- Fastify request URL logging must not expose callback code/state. Use a path-only serializer for sensitive callback routes and private/no-store responses with a restrictive referrer policy.
- Coordinate with WS-03: a valid session must survive loss of its final workspace membership; workspace authorization is a separate decision.
- WS-02 has been asked to keep invitation acceptance credential-independent at the transaction boundary.

## Verification

Use a local signed mock IdP with one-use authorization codes and real S256 verification. Cover sign-in, explicit linking, invite registration, email conflicts, final-credential protection, malformed state/nonce/issuer/audience/expiry/signatures, callback replay/concurrency, and cross-browser transactions. Inject time/randomness and the supported [customFetch seam](https://github.com/panva/openid-client/blob/v6.8.7/docs/interfaces/DiscoveryRequestOptions.md) where useful; retain a browser journey through an HTTP mock.
