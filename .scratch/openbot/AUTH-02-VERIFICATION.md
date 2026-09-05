# AUTH-02 verification

Implementation base: `db563cf` (WS-02 integrated baseline `62b0ab6`, plus WS-03 nullable identity and migration 0006 prerequisites). Frontend commit: `8d2b727` (cherry-picked from isolated child `e8f98bbbb24a956ca0a80380f53904938933b0ac`). Both independent reviews are clean at implementation candidate `80ffeb150123c2b8c76789a3f5cc841b557caf67`. The external release gates below remain required and unrun locally.

## Acceptance evidence

1. Unconfigured OIDC has no action. Empty environment configuration remains disabled; the normal local-owner flow remains intact. Unit configuration cases, HTTP disabled-route test, conditional web rendering tests, and ordinary `auth.spec.ts` cover this.
2. Authorization Code with S256 PKCE, random state/nonce, JWKS signature verification, and ten-minute browser-bound single-use transactions. `oidc-provider.test.ts` runs a signed RSA mock IdP with real code redemption and PKCE validation, rejecting state/nonce/issuer/audience/expiry/signature/code replay and unsafe authorization endpoints. `oidc-flow.test.ts` checks browser binding, expiry, callback concurrency, and revocation.
3. `oidc_identities` uses `(issuer, subject)` as primary key. Sign-in never looks up by email. Tests reject email auto-merging, cross-issuer/same-subject matches, different subjects, and linking an identity owned by another account.
4. `/app/security` requires a valid session, including users with no memberships. Link binds/revalidates the initiating session; unlink is protected by Origin, current session, and final-credential checks. OIDC credential changes serialize by user through a PostgreSQL advisory transaction lock; the runtime role does not gain UPDATE permission on users.
5. Invited registration checks a verified matching email and atomically commits invitation consumption, account, OIDC identity, membership/provenance, session, and audits. The reusable invitation transaction retains existing local acceptance. Existing email conflicts and revoked invitations reject without merging.
6. `apps/web/tests/e2e/oidc.spec.ts` passed a real browser journey covering explicit linking, sign-in, invited registration, invalid state, and replay, plus final-credential protection and unlink. `tests/e2e/oidc-api.ts` runs the actual Fastify routes/services, `openid-client`, SQL repositories, and signed HTTP mock IdP; no OIDC API response stubs are used. The in-memory SQL fixture does not emulate PostgreSQL locking or rollback.

## TDD observations

- Configuration tests failed because configured OIDC values were ignored, then passed after optional validated configuration was added.
- Migration test failed because `oidc_identities` did not exist, then passed with migration 0007.
- Protocol test failed at the unavailable provider seam, then passed with code/S256/nonce/state and signed token verification.
- Link/sign-in test failed at the unavailable flow seam, then passed after browser transaction and identity/session persistence.
- Invited registration failed as `identity_not_linked`, then passed after extending the atomic invitation transaction for OIDC credentials.
- HTTP route test failed with 404, then passed after route registration.
- Unsafe test authorizer endpoint test resolved an external HTTP URL, then rejected after applying endpoint policy to browser authorization URLs as well as backend requests.

## Local checks (2026-09-05)

- `pnpm typecheck`: API and web pass; Svelte 0 errors/0 warnings.
- Unit tests: API 59 + web 12 = 71 pass.
- Integration tests: API 92 + web 94 = 186 pass.
- Total unit/integration: 257 pass.
- Ordinary Playwright suite: 7 pass.
- Dedicated `playwright.oidc.config.ts`: 1 pass, covering all five required OIDC browser flows.
- `pnpm lint`, API production build, web production build, and `git diff --check`: pass.
- PostgreSQL OIDC suites: 5 tests skipped locally because their database URLs are unavailable. Skips are not passes.
- Shared browser ports 4399/4173 were released and confirmed free after verification.

## Independent reviews (2026-09-05)

Both reviewers examined the fixed diff from `db563cf8c98d4966e3a5dd270709d386cf974d63` to `80ffeb150123c2b8c76789a3f5cc841b557caf67`, independently of implementation.

- Standards reviewer `/root/prov03_standards`: CLEAN, no findings. Independently ran 30 API tests and 37 web tests, all passing, and audited the installed `openid-client` validation/source behavior. This review does not claim real PostgreSQL or Compose execution.
- Spec reviewer `/root/prov03_spec`: CLEAN, no findings against all six AUTH-02 acceptance criteria and the WS-02 atomic invitation contract. Inspected issuer/subject identity matching, session/browser binding, final-credential protection, invited-only registration, the disabled/local flow, and signed mock-IdP browser coverage. No additional test execution was claimed by this reviewer.

The final follow-up changes only this verification note and the ticket status; the reviewed implementation remains unchanged. The candidate is ready for integration after migration 0006, with the external release gates retained.

## External release gates — required, not run locally

On the final integrated commit, GitHub `Verify` must pass:

- `code`: complete local checks and both browser configurations.
- `postgres-auth`: actual PostgreSQL callback/invitation concurrency, atomic rollback, and session revocation (`oidc-runtime.test.ts`) alongside existing auth/invitation invariants.
- `postgres-oidc`: separate disposable PostgreSQL database with `TEST_OIDC_DATABASE_URL`; runs the actual deployment grant script, then link/sign-in/invited registration/unlink/final-credential/rollback and least-privilege checks (`oidc-privileges.test.ts`).
- `postgres-providers`: existing restricted-role provider checks against the expanded schema.
- `compose`: actual fresh and upgraded volume checks through migration 0007, startup ordering, runtime permissions, and existing application journeys.

No push, hosted IdP, real PostgreSQL, or Compose runtime verification was performed locally. The root release gate must retain these outstanding external checks; local pg-mem and browser results do not replace them.

## Combined integration (2026-09-05)

Integrated at `84f05b24649ce539025d368847da73bbb1a04422`: 352 unit/integration tests (75 API unit, 15 web unit, 148 API integration, 114 web integration), 9 ordinary browser scenarios and the real signed-IdP browser journey passed. Formatting, types, both production builds, workflow YAML and all 22 embedded shell steps passed verification.

Combined load exposed two test timing assumptions and excessive integration worker concurrency. Startup now validates configuration before dynamically loading runtime dependencies; the real-HTTP deadline regression expires its controlled signal only after headers arrive, while retaining exact production deadline assertions; API integration tests use four workers without increasing timeouts or replacing real Argon2. Root independently reviewed these three narrow changes. Membership BFF header/body-deadline fixes, restricted membership grants and the ordered 0006/0007 ledger are preserved.

`AUTH-02-E1` in REL-01 tracks the actual PostgreSQL and Compose checks still required on the integrated revision.

## Dependency/protocol references

Pinned `openid-client@6.8.7`, verified against upstream documentation for discovery, `AuthorizationCodeGrantChecks`, `enableNonRepudiationChecks`, and `DiscoveryRequestOptions`. Production configuration requires HTTPS and `client_secret_post`. The only HTTP exception requires explicit loopback test configuration. Provider access tokens and ID tokens are not persisted; session and browser tokens are stored only as digests. OIDC callbacks use private/no-store responses and no-referrer policy, and request logs omit query values.
