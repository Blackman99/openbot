# API-02 author verification

Implementation base: accepted BOT-06 merge `ae567149a1e741a830a244f751c379af50c9a523`.
Worktree: `.worktrees/api-02`; branch: `ticket/api-02`.
The written `API-02-CONTRACT.md` preceded implementation. Ticket49's six acceptance criteria and `PUBLIC-API-HANDOFF.md` remain authoritative. Independent Standards/Spec review, dedicated merge, acceptance, native CI execution and publication remain with root.

## Delivered behavior

Seven `/v1` operations use explicit API-01 Bearer scopes and the persisted token creator/workspace. They create, inspect, paginate, update with current-version CAS, inspect immutable history and archive through the existing Bot services. No migration or second archive implementation was introduced. No group/API-03 or deferred lifecycle endpoints were added.

Every public resource operation receives a server-created transaction admission callback. The callback rereads current membership, token identity, scope, revocation and expiry on the resource's actual SQL connection, after domain/provider/avatar waits and mandatory domain audit insertion, immediately before COMMIT. It uses the existing workspace-first order and samples token time at this final admission. A rejected callback rolls back the entire resource transaction. Ordinary API-01 token-use auditing remains separate and does not claim a completed Bot mutation.

The existing current and historical Web/public configuration mappers now share `botConfigurationView`, an explicit nested allowlist. This preserves all configuration fields and opaque avatar references while excluding future/internal persisted JSON fields. Public errors expose only the declared envelope, including malformed JSON, size and media-type errors.

The committed OpenAPI 3.1.1 document is `docs/openapi/bots.openapi.json`. Its JSON Schema 2020-12 request/response schemas are checked with Ajv 2020 against actual Fastify/domain results. The test verifies all seven operations, explicit Bearer scopes, success payloads, 401/403 permission errors, stale 409, invalid pagination 400 and denied resource access. These are schema/HTTP contract tests, not a claim of external OpenAPI tooling certification.

## Acceptance evidence

| Ticket49 criterion | Actual evidence |
| --- | --- |
| AC1 scoped retrieval/pagination | Read scope and exact current Web DTO; all read endpoints reject write-only/session-only clients; stable exclusive Bot UUID pages and descending immutable history; current discovery/direct ACLs, bound workspace, revocation, expiry and deprovisioning tests. |
| AC2 create/update/archive visible in UI | Real public creation produces active private Bot/version1/owner ACL. The existing Web client and actual Svelte browser page consume the same configuration and identity. Public update and archive are immediately visible in that page; repeated archive creates no version or extra archive audit. |
| AC3 UI configuration round trip | Existing Web/BFF client integration plus real browser editing of name, role, description, whitespace-preserved instructions and all four limits. The browser uploads an actual normalized avatar first; public retrieval/update and historical inspection preserve its reference and readable retained image. |
| AC4 stale update conflict | UI/public competing writes return exact 409 `bot_version_conflict`; current pointer and complete newer configuration remain unchanged. Browser journey independently exercises the same conflict. |
| AC5 redaction | Provider key/header sentinels stay out of public responses and rendered UI. Allowlist fault injection puts private-memory, encryption, provider/header and nested internal sentinels into persisted JSON; current/historical/list/history responses and the Web DTO exclude them. Invalid private/secret/storage/lifecycle input creates no version or mutation audit. |
| AC6 OpenAPI 3.1 contract | The document covers every public operation, body/schema limits, request fields, two pagination cursors, scope requirements and safe errors. Actual response schema validation and negative input schema examples pass. |

## Test-first witnesses

- Initial public GET/create/list/history/archive and update tests reached real existing services/UI behavior but failed because the public operation returned 404. Their minimal route implementations made those cases pass.
- Malformed JSON initially returned 503 instead of the specified 400. Mapping framework 400/413/415 failures into the safe public envelope made that transport test pass.
- The OpenAPI test first failed because its worktree document did not exist. The completed document then validated actual endpoint results.
- Persisted unknown nested configuration fields initially appeared in the public response. A shared current/history allowlist removed them; the test then passed and verified the identical safe Web view.
- Native lock/rollback tests could only be authored and discovered here. No native red/green observation or native pass is claimed.

## Actual final local checks, 2026-09-05

| Check | Result |
| --- | --- |
| API unit and integration suites, installed Vitest binary with `--maxWorkers=2` | **58 files, 422 tests passed**, 97.92 seconds. Includes all 13 new public Bot route/security/OpenAPI cases. |
| Web unit and integration suites, installed Vitest binary with `--maxWorkers=2` | **51 files, 511 tests passed**, 29.00 seconds. |
| Total nonbrowser tests | **933 passed**. |
| API source and tests typecheck | Passed, including the native suite. |
| Svelte diagnostics | **0 errors, 0 warnings**. |
| Repository Prettier and `git diff --check` | Passed. |
| Real-service browser journey, `public-bots.spec.ts` | **1 passed**, 30.6 seconds including server startup/builds; the actual journey took 4.1 seconds. API TypeScript production build and Web production build both completed. |
| Native `public-bots-runtime.test.ts` discovery | **31 skipped, 0 executed native cases** because `TEST_BOT_DATABASE_URL` is absent. |

The browser fixture uses the compiled real Fastify application, real token/Bot/ACL/version/lifecycle/provider services, a migrated pg-mem database and actual local avatar storage. Only the upstream model capability result is supplied as fixture data. Its added prerequisite builds the API before the existing browser fixture starts. The journey covers public create, UI avatar upload, all UI configuration fields, public get/update, stale CAS, history pagination, retained historical avatar, archive visibility and real token revocation. Browser page errors were empty. This validates Web/API interoperability; pg-mem is not PostgreSQL transaction evidence and no live upstream provider is claimed.

Root granted ports4399/4173 for that journey. Both were confirmed closed after the passing final run, and the lease was explicitly released. The first local startup encountered pnpm11 automatic dependency reconciliation; the successful invocation set `pnpm_config_verify_deps_before_run=false` only for the local command, using the already installed dependencies without replacing shared modules. This environment setting is not part of repository behavior.

## Native CI handoff

`API-02-NATIVE-EVIDENCE.md` describes all **31 registered native cases**, including real queued revocation, expiry after Bot/provider/avatar/audit waits, current direct authority, same-SqlConnection fault injection and complete post-mutation rollback snapshots. The tests run production services as the deployed `openbot_runtime` role and observe real lock waits with `pg_stat_activity` and `pg_blocking_pids`.

The `postgres-bots` Verify job adds a separate sequential command after the lifecycle suite. It first requires nonempty `TEST_BOT_DATABASE_URL`, preventing a native gate from silently succeeding through missing-URL skips. No existing gate is removed. Actual PostgreSQL execution and any resulting fixes remain open; source inspection, pg-mem results and skipped-case discovery do not close that gate.
