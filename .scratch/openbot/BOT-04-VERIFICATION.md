# BOT-04 implementation and verification

Base: `47553b1e5331aeaa869d44e96537b38d53d9fd2b`. The separate API contract is BOT-04-API-CONTRACT.md. Work is isolated on `ticket/bot-04`; independent reviews and final integration are coordinated by root.

## Behavior

Current explicit Bot owners manage owner/editor/user grants and private/workspace discovery visibility. Workspace and group administrative roles confer no additional Bot permission. New grants and promotions require current workspace membership; retained inactive grants can be demoted or revoked but cannot be promoted. Last-owner protection counts currently eligible owners. Workspace removal remains possible and immediately disables access without deleting the retained grant or immutable identity. Rejoining restores only still-explicit grants; explicit ACL revocation is not undone by rejoining.

All management and listing use BOT-01's existing `lockAuthorizedBot(..., 'manageAcl')` inside the repository-owned transaction. Target eligibility and eligible-owner counts are read after workspace/Bot lock admission. Effective changes and safe audit metadata commit atomically; no-op role/visibility writes add no event. IDs in audit metadata come from persisted Bot/target rows. Permission changes never append/rewrite a BotVersion or change the current pointer. Future edit/use/lifecycle authority is tested through the existing permission seam; lifecycle and version endpoints remain with their respective tickets.

Workspace visibility allows metadata discovery only. It never grants use, configuration inspection or editing. Revocation from a workspace-visible Bot removes configuration/use immediately while preserving explicitly configured discovery.

## Test-first evidence

- The grant/list tracer initially needed its provider fixture's required headers field corrected. With a valid fixture, actual Fastify POST `/acl` returned 404 before route registration; owner grant, target private inspection, owner listing and exact audit metadata then passed.
- Role changes, visibility changes and last-owner removal each returned 404 before their routes/repository operations existed. The next green slice covered owner/editor/user transitions, immediate revocation, discovery-only visibility, no-op auditing, immutable pointer preservation and inactive retained owners.
- Additional API coverage exercises every management operation under workspace-owner/admin, Bot-editor/user and group-owner identities; denials leave ACL/Bot/audit state unchanged. It also covers lost workspace access, retained and explicitly revoked grants on restored membership, uppercase route/target UUIDs, cross-workspace target and Bot IDs, strict inputs, duplicate grants, session/Origin enforcement and safe database errors.
- An injected audit failure confirms the fixed 503 error boundary. It is not rollback evidence: pg-mem does not establish transaction atomicity.

## Restricted-role PostgreSQL gate: BOT-04-E1

`apps/api/tests/postgres/bot-acl-runtime.test.ts` contains nine real PostgreSQL cases. They invoke the actual deployed role provisioner and exercise narrow privileges, simultaneous owner self-demotions, reciprocal revocations, currently eligible ownership, all four mutation/audit rollback paths and both commit orderings for ACL/workspace revocation versus a queued mutation. Lock waits are observed with `pg_stat_activity` and `pg_blocking_pids`.

The `postgres-bots` job runs `bots-runtime.test.ts`, then `bot-acl-runtime.test.ts` in two separate vitest commands. This avoids racing the fixed runtime role's password. Root's serial CI wiring commit `8c488dc` was incorporated as `dc867f3`.

The native file locally discovered and skipped all nine cases because `TEST_BOT_DATABASE_URL` is absent. No local PostgreSQL or Docker execution is claimed. BOT-04-E1 remains open for actual CI and the root-owned release gate.

No schema migration changes are needed. Runtime grants add only bots UPDATE(visibility), bot_acl UPDATE(role) and bot_acl DELETE. Existing native and Compose expectations are updated to explicitly allow these additions while continuing to reject Bot/ACL identity-field updates, table-wide updates and immutable version changes. Workflow YAML and all 27 shell steps passed syntax checks.

## Future group-grant boundary

Root's COL-02 decision requires permanent closure of related group grants in the same ACL-revoke/workspace-remove transaction once that schema exists. BOT-04 preserves the transaction boundary but adds no speculative schema or placeholder hook. Rechecking a future grantor alone will not substitute for permanent closure.

## Final checks and review

UI/client source was supplied by a separate author at `9b9f308` and `8b758ff`, incorporated as `38def5e` and `bd3ba9d`. The owner permissions page includes current same-workspace candidates, explicit roles, private/workspace discovery, retained-inactive explanations, last-owner errors and self-demotion/removal navigation. The strict client validates success receipts and safe errors, sends JSON headers only with a body, and retains its deadline through response body decoding. Node HTTP deadline tests cover both stalled success and error bodies. Two further API tests cross the actual Fastify server with this client, including ownership transfer/self-demotion/self-revocation and fixed error mapping.

Final combined source: `bd3ba9db5a0463fb52ff4711144c6db235142ca4`. The following sequence completed with exit code zero:

```sh
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm build
pnpm test:e2e
```

| Check | Result |
| --- | --- |
| API unit | 77 passed |
| API integration | 234 passed, including 15 ACL and two actual HTTP client cases |
| Web unit | 35 passed |
| Web integration | 305 passed |
| Total unit/integration | 651 passed |
| Formatting/types | Passed; Svelte zero errors and warnings |
| Production builds | API and Web passed |
| Ordinary browser scenarios | 17 passed in 56.0 seconds, including two BOT-04 scenarios |
| Signed-OIDC browser scenario | One passed in 24.2 seconds |
| Native BOT-04 local discovery | Nine skipped without `TEST_BOT_DATABASE_URL`; not execution evidence |

The browser scenarios cover grant/role/revoke, current eligible last owner, discovery-only projection, next-request revocation, workspace removal/rejoin and self-revocation while retaining valid sessions. The UI author's initial browser test used an incorrect identity URL; it was corrected before integration, and the complete combined browser run passed. Actual TCP connections to 4399 and 4173 returned ECONNREFUSED after completion, and the lease was released to root.

The subsequent final commit `ee7adb1aaa062d37cf676421d17a9b75c41d7da3` changes only this evidence note and the ticket status/checklist. Independent Standards and Spec reviewers both reported CLEAN against source `bd3ba9db5a0463fb52ff4711144c6db235142ca4`. Standards independently ran 17 API/real-HTTP and 40 Web tests; Spec independently ran 17 API/real-HTTP tests. Neither reviewer authored this ticket or claimed native database execution.

Dedicated integration `8d1933f51ff43c1c01616e8d885cf9ae75e41995`, tree `41fbbdb04983beb1005da40026ea9cd7a51274e8`, merged without conflicts or source fixes; only root-owned documentation differs from the reviewed candidate. The integrated full `pnpm verify` exited0:651 unit/integration tests,17 ordinary browsers in49.5s,one signed-OIDC journey in21.9s,formatting/types/builds all passed. YAML,27 Bash steps/service options and changed MJS syntax passed. Log: `/tmp/openbot-bot-04-integrated-verify.log`. Both browser ports were confirmed closed and the root/port leases released. BOT-04-E1 remains open until actual native PostgreSQL and deployed Compose CI evidence succeeds.

BOT-04-E1 closed by [Verify33948405362](https://github.com/Blackman99/openbot/actions/runs/33948405362), all six jobs successful on remote `fa79a3dd85baf0dd2acf888d5f39a2a071d83fd8`, completed2026-09-05 at05:57:03 UTC. The published tree `040312fdf38cea26574dddc06a343b46d417d977` exactly matches local `86bdf75fa7b5b392f41af85e856b01e775991185`, verified by fetch and pinned diff. The dedicated postgres-bots job101258691651 executed the eight identity and nine ACL cases in separate successful commands. Compose job101258691734 passed fresh/upgrade startup, precise visibility and ACL role/delete privileges, and all prior application/outage checks; code, postgres-auth, postgres-providers and postgres-oidc also passed. This closes the external gate without counting local skips as execution; fifteen tickets are fully complete.
