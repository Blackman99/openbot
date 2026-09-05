# API-01 integration handoff

Base: `34d3e615ea0c41679fe0ffc7fe4ac9e4e8d5a22d`.
Worktree: `.worktrees/api-01`; branch: `ticket/api-01`.

## Local verification — 2026-09-05

- API: 204 tests passed across all 28 unit/integration files, using `pnpm --filter @openbot/api exec vitest run tests/unit tests/integration --maxWorkers=2`.
- Web: 110 tests passed across all 19 unit/integration files, using `pnpm --filter @openbot/web exec vitest run tests/unit tests/integration --maxWorkers=2`.
- Total: 314 unit/integration tests passed. Early concurrent default-worker runs hit existing 5-second authentication/startup timing limits; focused reruns and the complete bounded-worker run passed without changing timeouts. Root has independently integrated a worker cap and deferred startup imports in AUTH-02; preserve those newer changes on merge.
- Browser: focused API-token journey passed, followed by all 10 browser journeys. This exercises actual Clipboard API copying, creation-only secret visibility, redacted reload, revocation and public rejection. Ports 4399 and 4173 were released and verified free.
- Formatting and strict API/Web typechecks passed; Web reported zero errors and zero warnings. Both production builds passed serially. Existing Vite empty-env-chunk/plugin timing notices remain non-failing build output.
- UUID casing follow-up: witnessed uppercase workspace UUIDs causing BFF listing to fail, then witnessed uppercase token UUIDs producing noncanonical audit references. Token workspace and revoke IDs now normalize after validation; the BFF compares UUID references case-insensitively while preserving exact comparison for opaque IDs. The real HTTP lifecycle covers uppercase workspace/token IDs and canonical metadata/audit references. Focused API12 + Web18 tests and both typechecks passed for this change; the 314-test/full-browser/build results above precede this narrow follow-up.
- Real HTTP: Web-to-Fastify token creation/listing/bodyless DELETE pass, and the client deadline covers a stalled response body. Other member/invitation transport regressions remain green.
- PostgreSQL command reported 5 suites / 11 tests skipped because `TEST_DATABASE_URL` and provider test database configuration are absent. Two new API-token cases are present but **not executed** locally. No Docker/Compose runtime evidence is claimed.

## Review follow-up — admission-time expiry

- Independent standards review was clean at `4483ded`; independent specification review confirmed P2: authorization captured time before pool/workspace-lock admission, so a token expiring while queued could receive HTTP 200 and a stale last-used timestamp.
- A real Fastify/service/pg-mem repository regression with controlled lock admission first returned 200 instead of 401. Authorization now receives the service clock without sampling it until the workspace lock is acquired; the expiry predicate, successful last-use update and use audit share that fresh timestamp inside the transaction.
- The related creation test also demonstrated 201 instead of 400 when its requested expiry elapsed while queued. Creation now validates future expiry after admission, records creation/audit time from admission, and returns the persisted creation timestamp. Expired queued creation inserts neither a token nor a creation audit.
- Three focused regressions cover expired queued use, expired queued creation and fresh creation/use/audit timestamps. All 27 affected API tests (token lifecycle, HTTP deadlines, membership and production composition), API strict typecheck, repository lint and diff checks passed. The existing native PostgreSQL audit-rollback tests were updated for the deferred-clock repository contract but remain pending actual database execution.
- No new browser or broad-suite run was performed for this bounded server fix. The earlier full-suite/browser/build evidence is unchanged; both independent review axes subsequently rechecked this pin clean; root must still verify the integrated branch.

## Acceptance coverage

| Acceptance | Evidence |
| --- | --- |
| Creation-only plaintext; hashed storage and safe audits/logs | API creation/storage and logger regressions; BFF redaction parsers; one-time UI action/render/browser checks |
| Creator/workspace/name/fixed scopes/expiry/last-use | Metadata assertions, bounded expiry/scope validation, current role checks and public-use timestamp update |
| Invalid/expired/revoked/forged/orphan 401 at `/v1/me` | Public API integration cases, boundary expiry, member removal and identical-timestamp rejoin |
| Missing scope 403 without target mutation | Scope rejection leaves workspace state and last-use unchanged; current-creator resource service composition prevents privilege elevation |
| Settings create/copy/list/revoke | Page/action/client tests and browser Clipboard API journey |
| Security audits for creation/use/revocation | Exact safe metadata assertions, idempotent revocation and member-removal audits; native transactional rollback cases pending CI |

## Integration details

- Provisional migration `0010_scoped_api_tokens` is the only new migration. Root may renumber it before first publication, with the ledger assertions and notes updated consistently. `0007` was published through AUTH-02 after this branch's base and must remain immutable.
- Shared files: `apps/api/src/app.ts`, `runtime.ts`, `database/migrations.ts`, member repository, migration tests, `README.md`, Web workspace navigation and browser fixture, runtime grants, Verify workflow. Preserve AUTH-02 composition, WS-03 semantics and sibling fixture registration when resolving overlaps.
- Member removal invokes token revocation on its existing SQL connection while holding the workspace lock; token metadata and audits survive membership removal. All token writes and authorization use the same workspace-first locking order.
- Runtime grants add SELECT/INSERT on `api_tokens` and UPDATE of `last_used_at` / `revoked_at` only. No expiry/scope/identity/digest UPDATE, DELETE or TRUNCATE grant.
- `infra/verify-api-tokens.mjs` is piped into `docker compose exec -T api node --input-type=module` immediately before the outage smoke. It uses the real API and restricted database role to check lifecycle, hashed storage, immutable-column/deletion permissions and membership-removal revocation. It logs only a fixed success message or safe stage name.
- The native PostgreSQL suite runs in an isolated disposable schema under the existing `postgres-auth` CI job. It covers audit-failure rollback and concurrent token issuance/removal, including rejoin at the exact old membership timestamp.
- Token credentials are Bearer-only for the public API; the management API remains cookie/Origin protected. Public `/v1/me` requires `me:read`; session `/api/v1/me` remains separate.
- API-02–06 must use the returned creator identity and bound workspace for fresh resource ACL checks in the target domain service/transaction. Scope validation alone never authorizes a bot/group/task/approver operation. The fixed scopes are documented in the ticket and README.

## Outstanding gates

1. Root integration verification completed at47a6008:478 unit/integration tests,12 ordinary browser scenarios plus one real signed-IdP journey, formatting/types/builds and24 shell-step syntax checks passed. Final migration0010 follows0009.
2. Mandatory `API-01-E1` real PostgreSQL and restricted-role Compose CI evidence. Root owns REL-01, PROGRESS, issue-index state and publication.

## Independent review completion

Final reviewed code: `96ab273ddf217fc9653cb0884c42ada7c2e74907`, against original base `34d3e615ea0c41679fe0ffc7fe4ac9e4e8d5a22d`.

- Standards reviewer `/root/auth_02` was clean at4483ded after 31 independent API/Web tests. Its delta recheck at96ab273 passed all 12 token tests, preserved workspace-first locking/current membership/audit rollback and confirmed fresh post-lock time for authorization and creation. No findings remain.
- Spec reviewer `/root/prov03_spec` initially demonstrated the expiry-after-lock-wait P2. Its recheck at96ab273 passed all 12 token tests, including the three new actual route/repository regressions, and closed the finding. No other acceptance gaps remain.

These are independent review results, not real PostgreSQL or Compose execution claims. The candidate is ready for root integration with API-01-E1 retained until actual CI passes.

## Canonical member-removal audit follow-up

Root identified raw uppercase workspace route IDs in member-removal token audits. The author reproduced this through the real member DELETE route and fixed it in498fdec by auditing canonical workspace_id returned from the token UPDATE. Root independently reviewed the two-file delta and integrated it as3c7783d. All21 token/member tests, API typecheck and lint passed in the author worktree; no new broad/browser evidence is claimed for this small server fix.
