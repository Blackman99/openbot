# API-02 accepted integration

API-02 is fully complete. [Verify33960029570](VERIFY-33960029570.md) closed API-02-E1 with 31 actual restricted-role public-Bot PostgreSQL cases and all 12 jobs successful on 2026-09-05 at 10:17:34 UTC. That subsequent run passed a new complete `pnpm verify`. The earlier local gate below remains an accepted composite result; its first full invocation exited 1.

## Accepted source and integration

| Item                        | Pin                                        |
| --------------------------- | ------------------------------------------ |
| Accepted merge              | `bdaa32526383739243a227a7c5023a4c8b3e7ffd` |
| Final tested tree           | `b2a174630bef5616d6a8dc7140adf349d50f6fde` |
| First parent                | `675fd53c0ac098abac05a1560ce339abd7ae9df1` |
| Reviewed API-02 parent      | `18ad24f06dd8a5afe2b795462975d186a0650487` |
| Reviewed API-02 source tree | `58cf11938c9939fa3d78815cf9e5ef42f5bf126d` |
| Initial integrated tree     | `a87828b0ad69d60c2dadd847bd5ddf7fdf17db1e` |

Both independent author review axes were CLEAN. Root independently reviewed the seven shared integration paths, parent/blob comparisons and the final fixture reset correction as CLEAN. Of the incoming 31 changed files, 24 retained exact author blobs; of the root's 130 changed files, 123 retained exact root blobs. The seven shared paths are the Verify workflow, root README, API package manifest, API app registration, Bot ACL test fixture, Playwright configuration and browser fixture API.

Integration retains the separate Task worker, response locator and Bot author projection, actual migrations 0016 → 0017 → 0018, attachment storage limits, the reviewed Task native audit correction, Bot copy and lifecycle behavior. API-02 adds no migration. Its native command follows all six existing Bot suites serially and rejects an absent database URL. Public routes retain Bearer scope checks, the current token creator/workspace, same-SQL-transaction final reauthorization and the nested current/history configuration allowlist.

## Actual local gate, 2026-09-05 UTC

| Command/component                                                                                                                      | Time              | Actual result                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial `pnpm verify`                                                                                                                  | 09:53:18–09:56:50 | **Exit 1**. Formatting, API/Web types and all 1,075 nonbrowser tests passed. Ordinary browsers: 36 passed, one status scenario failed; OIDC and final builds were not reached. |
| Unchanged public → status regression: `pnpm --filter @openbot/web exec playwright test public-bots.spec.ts status.spec.ts --retries=0` | 09:58:43–09:59:17 | Exit 0; all three cases passed on the final tree. These repeat cases are additional diagnosis, not added to the ordinary total.                                                |
| `pnpm test:e2e`                                                                                                                        | 09:59:39–10:01:56 | Exit 0; **37 ordinary browser journeys and one signed OIDC journey passed** on the final tree.                                                                                 |
| `pnpm build`                                                                                                                           | 10:01:56–10:02:11 | Exit 0; API and Web production builds passed sequentially on the final tree.                                                                                                   |

The nonbrowser result is API 99 unit + 372 integration and Web 65 unit + 539 integration: **1,075 passed**. Web diagnostics reported zero errors and zero warnings. The accepted composite combines these unchanged checks from the initial invocation with the corrected final browser/build results; it does not claim a later full `pnpm verify` exit 0.

The failing status scenario received `Ready` because the preceding real public-Bot fixture still owned request routing. The approved fixture-only change moves `resetPublicBotFixture()` from `resetAuth()` to every explicit `/__scenario` callback. The existing reset synchronously clears active routing and serializes closure of the captured previous app. Production code, all 37 existing scenarios and their assertions, retry counts and timeouts are unchanged. The regression and complete ordinary suite verify the corrected fixture boundary.

The final ordinary suite includes `public-bots.spec.ts` (3.1 seconds): a real Fastify/domain/migrated-pg-mem/private-avatar/Svelte round trip covering public create, UI editing/avatar upload, public get/update, stale CAS, immutable history/pagination, retained avatar, archive visibility and token revocation. This proves API/Web interoperability; pg-mem is not native PostgreSQL transaction evidence.

The local environment used existing installed dependencies with `pnpm_config_verify_deps_before_run=false`; exact Ajv 8.20.0 and ajv-formats 3.0.1 links required no dependency installation or repository configuration change. Ports 4399/4173 were confirmed closed and released after verification.

## Historical local skips and subsequent actual-service evidence

All 31 public-Bot native cases were registered and skipped locally because the database URL was absent; **zero API-02 native cases were executed**. [Verify33959031255](VERIFY-33959031255.md) predates API-02 and cannot close API-02-E1. [Native coverage](API-02-NATIVE-EVIDENCE.md) records the exact lock, final-admission and rollback assertions.

The separate attachment S3 test-budget correction was integrated after this tested merge as `86c77c6ce50478703ee32c5a0fb7a05dce24775e`; it was not part of the API-02 composite gate. Verify33960029570 subsequently passed all 14 local/S3 cases, including the unchanged large-file case in 7,713 ms, closing ATT-01-E1 too. The authoritative local record is `api02-integration-final.json`, with the original full-command log/exit, focused regression and remaining browser/build log/exit retained outside the repository.
