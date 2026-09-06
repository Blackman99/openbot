# API-02 native PostgreSQL evidence

## Status

**Native execution is complete.** [Verify33960029570](VERIFY-33960029570.md) executed all 31 cases in postgres-bots job101290513512 on 2026-09-05 at 10:16:08.3154032 UTC, after six successful serial Bot suites. The actual checkout tree exactly matches accepted local `e51fafe4`; all 12 jobs passed. API-02-E1 is closed.

The following records the earlier local author checkpoint. `TEST_BOT_DATABASE_URL` was absent in that environment. The new suite registers **31 cases; all 31 were skipped locally**. No PostgreSQL server, Docker service, database provisioning, executed native assertion, upstream provider call, browser result or deployed Compose result is claimed. A native red/green cycle could not be observed without the required database.

The suite was authored in isolated branch `ticket/api-02-native`, created from accepted BOT-06 merge `ae567149a1e741a830a244f751c379af50c9a523` and then fast-forwarded to API-02 core checkpoint `a7a6dd4` for the production route and transaction-admission interfaces. Its deliverable changes only `apps/api/tests/postgres/public-bots-runtime.test.ts` and this evidence note. The public contract and `PUBLIC-API-HANDOFF.md` define the admission requirements; independent Standards/Spec review and ticket acceptance remain with the parent/root workflow.

## Executable native coverage

The setup applies the real migrations, invokes `infra/postgres/grant-runtime-privileges.mjs`, and connects production services as `openbot_runtime`. Requests use the actual Fastify `buildApp` with PostgreSQL token, Bot, version, avatar and lifecycle services. The only provider stub supplies Basic capability evidence; the suite does not replace token admission, domain services, SQL connections or transaction behavior with mocks. Avatar scenarios publish and read actual normalized image bytes through the existing local object store.

| Area | Cases | Assertions |
| --- | ---: | --- |
| Runtime grants and successful public operations | 1 | Restricted role flags, exact token UPDATE columns and append-only audit privileges; public create, edit, archive and get retain the real token creator, private initial identity, owner ACL, version pointer and mandatory domain audits. |
| Expiry after mandatory domain audit | 3 | An `AFTER INSERT` barrier selects `bot.created`, `bot.version_created` or `bot.archived`. Early `api_token.used` is already committed. Expiry at the exact deadline after the selected domain audit denies the request and rolls back all domain records. |
| Same resource SQL connection | 3 | An invoker audit trigger revokes the request token inside the open create/update/archive transaction. A second connection observes the still-valid committed token while the writer waits. A final `401 invalid_api_token`, complete domain rollback and rolled-back token revocation prove admission consumed that transaction's uncommitted state. This is explicit fault injection, not a claim that ordinary revocation bypasses the workspace lock. |
| Bot row waits | 5 | Get, update, archive, version list and historical version get reject expiry reached after early authentication while waiting on the actual Bot row. Reads release no authorized result; writes leave snapshots unchanged. |
| Provider scope waits | 4 | Create, explicit-model update, get and list reject expiry reached while waiting for the actual creator's personal-provider advisory lock. |
| Retained avatar wait | 1 | Expiry while an update waits on the retained object row leaves the original version pointer, object and avatar reference intact and preserves readable avatar bytes. |
| Real revocation wins admission | 7 | Each public endpoint first authenticates, then its resource transaction queues behind the real token revoker. Separate selective authentication/revocation audit barriers establish the waiter order. After revocation commits, all seven endpoints deny with `401` and preserve every domain record. |
| Admitted mutation wins revocation | 1 | An update holds workspace/token authority while waiting first on provider admission and then on its domain audit. A real token revoker remains queued until the update commits its version, pointer, reference and audit; later reads with the revoked token fail. |
| Current scope and direct ACL | 1 | Read/write scopes do not imply one another. Workspace ownership grants no direct Bot access. A newly granted editor writes as the actual token creator, cannot archive, and loses access after current ACL removal. |
| Persisted creator and workspace | 1 | Even when the creator belongs to another workspace, the token cannot discover or retrieve that workspace's Bot. A workspace owner's token cannot create through another person's personal model binding. |
| Membership removal and rejoin | 1 | Actual membership removal revokes the token. Rejoining restores retained direct Bot authority for a fresh token but cannot revive the old credential. |
| Queued current ACL loss | 1 | Real owner ACL revocation queues during early authentication, wins the workspace lock, and commits before the waiting edit. The still-valid token receives resource denial; no version, pointer, avatar or domain mutation escapes. |
| No-op final admission | 2 | A no-op configuration update and repeated archive still reject expiry after their Bot-row wait, without producing a new version or domain audit. |
| **Total** | **31** | **Registered native cases, not executed native passes.** |

Every concurrency assertion observes `pg_stat_activity.wait_event_type = 'Lock'` and `pg_blocking_pids`, matching each downstream waiter to its actual preceding holder. Barriers use separate PostgreSQL connections. Selective domain-audit barriers do not stop the earlier `api_token.used` audit. The reverse-order revocation test also checks the same observed writer PID across provider and domain-audit waits.

Rollback snapshots include every Bot in the fixture workspace, full immutable version rows, current-version and lifecycle fields, ACL rows, avatar object/reference rows and domain audits. Snapshot equality catches newly created identities as well as mutations of the existing Bot. The deliberately separate early token-use audit remains recorded when a later resource check denies the request.

## Actual local verification

On 2026-09-05, using the already installed tool binaries:

| Check | Actual result |
| --- | --- |
| `./node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit` | Passed for API source and tests, including the new suite. |
| `./node_modules/.bin/vitest run tests/postgres/public-bots-runtime.test.ts`, from `apps/api` | Exit 0; one suite and **31 cases skipped** because `TEST_BOT_DATABASE_URL` is absent. |
| `./node_modules/.bin/vitest run tests/integration/public-bots.test.ts`, from `apps/api` | The inherited API-02 core baseline passed **6 integration cases** after generating the worktree's SvelteKit metadata. These are not native transaction evidence. |
| Focused Prettier check on the native test and evidence note | Passed. |

The initial `pnpm` invocation stopped at `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` while attempting automatic dependency reconciliation. Verification then used the existing installed binaries directly; no package install or shared-module replacement was performed. Temporary dependency links and generated SvelteKit metadata are not part of the deliverable.

## CI handoff

Run this file as a **separate sequential command** after the other restricted-role Bot suites, because the deployed role provisioner rotates the fixed `openbot_runtime` password. The caller must require a nonempty database URL before invoking Vitest so a native CI gate cannot silently pass through discovery skips. From `apps/api`:

```sh
test -n "$TEST_BOT_DATABASE_URL"
./node_modules/.bin/vitest run tests/postgres/public-bots-runtime.test.ts
```

The author subtask did not edit CI or root files. Its requested actual native execution is now recorded above and in [Verify33960029570](VERIFY-33960029570.md); the local skipped run remains unchanged in this history.
