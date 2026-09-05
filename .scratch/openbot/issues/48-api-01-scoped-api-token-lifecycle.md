---
sequence: 48
id: API-01
title: "Scoped API token lifecycle"
status: complete
blocked_by:
  - WS-03
labels:
  - area:api
  - area:security
  - kind:feature
  - priority:mvp
---

# API-01 — Scoped API token lifecycle

## Outcome

Workspace members can create, inspect, and revoke scoped API tokens whose plaintext is revealed only once.

## Blocked by

- [WS-03](05-ws-03-manage-workspace-members-and-roles.md)

## Acceptance criteria

- [x] The creation response is the only place the full token appears; plaintext is absent from the database, audit records, and application logs.
- [x] Each token is bound to its creator and one workspace, with a name, fixed scopes, expiration, and last-used timestamp.
- [x] Expired, revoked, forged, or orphaned tokens receive 401 from /v1/me.
- [x] A token missing the required scope receives 403 and causes no target-resource mutation.
- [x] The settings UI can create a token, copy its one-time secret, list redacted metadata, and revoke it.
- [x] Creation, use, and revocation emit security audit events without secret material.

## Non-goals

- Third-party OAuth authorization
- Independent service accounts
- Tokens in URL query parameters


## Implementation decisions

- Browser-session token management uses GET/POST `/api/v1/workspaces/:workspaceId/api-tokens` and DELETE `/:tokenId`; the authenticated user can manage only their own tokens. The settings page is `/app/workspaces/:workspaceId/settings/api-tokens`.
- POST accepts `{ name, scopes, expiresAt }`, returns `{ token, secret }`, and is the sole response revealing the `ob_` secret. GET returns `{ tokens, availableScopes }` with ID, creator/workspace IDs, name, fixed scopes, creation/expiry/last-used/revocation times. No secret suffix or digest is exposed. All token responses and settings pages use private/no-store caching.
- Public GET `/v1/me` accepts Bearer headers and requires `me:read`. Session identity remains distinct at `/api/v1/me`. Invalid, expired, revoked, forged, or membership-orphaned tokens return 401; insufficient scope returns 403 before any target mutation.
- The fixed catalogue is `me:read`, `bots:read`, `bots:write`, `groups:read`, `groups:write`, `tasks:read`, `tasks:write`, `tasks:approve`, `events:read`. The UI defaults to 30 days with `me:read`; creation requires a future expiry at most 365 days away. Scopes cannot be edited after creation.
- Each authorization re-reads the creator, bound workspace and current membership/role. Token creation, authorization and revocation share the workspace row lock used by membership changes. Member removal permanently revokes all affected tokens in that same transaction, preserving redacted metadata and audit history; rejoining at an identical timestamp does not revive old credentials.
- `ApiTokenService.authorize` / `authorizeApiRequest` validate bearer credentials, membership and scope and return the current creator/workspace identity. **Downstream API-02–06 handlers must pass that creator and bound workspace into the target domain service, which must recheck current bot/group/task/approver ACLs in the target operation's transaction.** A scope is not an ACL grant; the integration test composes token authorization with a real workspace mutation and proves a member write scope cannot elevate workspace authority.
- Successful creation, permitted/insufficient-scope use, and material revocation append security audit events with token ID/workspace ID, scope/outcome or revocation reason only. Token creation, use-state updates and revocations are transactional with mandatory audit inserts. Anonymous invalid credentials are never stored in audits.
- Migration `0010_scoped_api_tokens` follows the integrated group migration `0009`; its version is fixed on first publication. Runtime grants permit SELECT/INSERT and only `last_used_at`/`revoked_at` UPDATE; immutable token name, scopes, creator, workspace, expiry and digest have no UPDATE grants.
- A witnessed logger regression showed rejected URL tokens in default request logs. Request serializers now exclude query strings, and unknown-route responses use a fixed error without echoing the URL. Header credentials, bodies and creation responses remain out of application logs.

## Verification record

- Red-first tests witnessed missing creation (404), missing public identity (404), missing metadata/revocation (404), unrevoked credentials after membership removal, and raw query-token leakage. BFF client, action and rendered-page tests first failed because the requested boundary was absent; the runtime privilege contract and production route composition also failed before implementation.
- Focused browser creation/copy/reload/revoke passed, followed by all 10 browser scenarios. Both shared E2E ports were confirmed free after the suite.
- Real HTTP tests connect the Web client to Fastify for create/list/bodyless DELETE and connect to a server that stalls after response headers, proving the deadline remains active through body parsing. Additional checks cover current roles, creator/workspace isolation, cross-origin requests, malformed scopes/expiry, once-only secret exposure and resource permission composition.
- Follow-up real-HTTP regressions witnessed uppercase UUID workspace comparisons failing in the BFF and uppercase token IDs leaking into audit references. Workspace IDs and revocation token IDs now normalize after validation, and UUID metadata comparison is case-insensitive.
- Independent specification review confirmed stale pre-lock time could authorize a token that expired while queued. A witnessed 200→401 route/repository regression now samples the clock only after workspace-lock admission and uses the fresh time for expiry, last-use and its audit. A related witnessed 201→400 creation regression rejects queued requests whose expiry has elapsed before insertion; accepted creation metadata/audits use the actual admission time. Three added regressions and all 27 affected API tests pass; both independent review axes are now clean at `96ab273ddf217fc9653cb0884c42ada7c2e74907`.
- Final local test counts and build evidence are recorded in `../API-01-EVIDENCE.md`. Independent Standards and Spec reviews, including the expiry/creation admission-time delta, are clean; both reviewers independently passed the 12-case token regression suite.

## External verification exception — API-01-E1

- [x] Execute the two isolated-schema cases in `apps/api/tests/postgres/api-tokens-runtime.test.ts` against real PostgreSQL: audit-failure rollback for creation, use-state updates, revocation and member removal; concurrent token creation/removal; and identical-timestamp rejoining without credential revival.
- [x] Execute `infra/verify-api-tokens.mjs` through the Compose CI step under the restricted `openbot_runtime` database role: create/hash-only storage, public identity, redacted list, forbidden scope/expiry/DELETE SQL privileges, insufficient scope 403, idempotent revoke and member-removal revocation with a retained session.
- [x] Complete fresh/upgrade Compose startup with the integrated migration ledger and the unchanged append-only audit guard.

These remain mandatory REL-01 release evidence until an actual GitHub CI run passes. pg-mem, fixture browsers, and skipped local PostgreSQL tests do not close this gate. Root owns the REL-01/index/PROGRESS updates and final integrated migration number.

## Integrated verification

Integrated at `47a6008`: all 478 unit/integration tests, 12 ordinary browser scenarios and one real signed-IdP journey passed, with formatting, strict types (zero Web warnings), both production builds and all 24 workflow shell steps passing syntax checks. Both original review axes are clean at96ab273. Root independently reviewed integration-only migration privilege assertions, logger/404 composition and the shared stalled-response-body regression.

A narrow post-integration regression reproduced a member-removal route with an uppercase workspace UUID emitting a noncanonical token audit reference. Author commit498fdec (integrated3c7783d) uses canonical `workspace_id` returned by the revocation UPDATE; root independently reviewed the two-file delta. The author passed all21 token/member integration tests, API types and lint. Actual API-01-E1 remains open until the combined GitHub CI succeeds.

## Closed external evidence — API-01-E1

API-01-E1 closed by [Verify33945439831](https://github.com/Blackman99/openbot/actions/runs/33945439831), all five jobs successful on remote `4429ccdc8a61d6771b954c70dc0d6a1ab7b43873`, completed2026-09-05 at04:49:16 UTC. Published tree514ec8f9b70b5a760154171957ba566b0bf28242 exactly matches localf3d3671. The run passed539 code tests,14 ordinary browser scenarios plus one signed-IdP journey,16 auth/invitation/member/OIDC/group/token PostgreSQL cases,5 restricted provider cases, the separate OIDC privilege case and the complete fresh/upgrade/runtime-role/application/outage Compose flow.
