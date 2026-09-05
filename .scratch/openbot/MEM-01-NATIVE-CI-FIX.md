# MEM-01 native and Compose CI contract corrections

Base: `b5a744f7e8637168832f054e524f80af671a65be`.
Native test source: `b5826afea4a166ae4aa8e4f125d8cc9216c94d36`, tree `b57479946760f7d473a091033287eb492b3bd2c2`.
Combined test/verification source: `1e5f77a263718ed760541e9ee7ae6db73e36fcab`, tree `f26e2138eb82cfd33313e9c0a21b05769d714f81`.

The three changed source paths are `apps/api/tests/postgres/memories-runtime.test.ts`, `infra/verify-memories.mjs`, and `.github/workflows/verify.yml`. There are no production, migration, privilege, fixture-role, or original-AC changes.

## Actual CI RED

Run `33964449861`, job `101302400523`, executed the real PostgreSQL runtime-role suite: 12 passed and 2 failed, exit 1. Captured log: `/workspace/scratch/2bc98607b3a9/ci339644-job-101302400523.log`.

- The observed-edit-wait test requested an `inspect` conversation transaction and then called `edit`. The existing `write` boundary requires `use`, so the blocker raised `ConversationAccessError` before editing and committing the source. The corrected blocker requests `use`; the test also checks the persisted original and second revision, then keeps the old-memory read denial and empty current list assertions.
- The purge test expected `command_hash=NULL`. Actual ATT-01 migration 0018 retains its `CHAR(64) NOT NULL` shape and requires the exact 64-zero redaction sentinel while setting `body` and `reason` to null. The corrected test first proves the created/deleted two-event chain is present, then compares its complete ID/sequence/actor identity after cleanup with the exact redacted values. Pending-purge exclusion, zero remaining object files, completed cleanup, denied source re-save, retained Run reference, and forbidden final publication checks remain.

The same run's general Compose job `101302400531` stopped at the memory helper's scope-denial audit stage, exit 1; captured log: `/workspace/scratch/2bc98607b3a9/ci339644-job-101302400531.log`. The helper attempted `SELECT audit_events` through its intentionally append-only runtime pool. The correction keeps every API/seed/current-source/retained-table operation under `openbot_runtime` and explicitly asserts audit SELECT=false/INSERT=true. It emits only the denied actor UUID and exact expected safe audit metadata. The workflow validates one well-formed receipt, then uses the existing PostgreSQL container's separate privileged observation connection. Quoted psql variables select this actor's exact event kind, and complete JSON equality requires precisely one audit with no additional content-bearing fields. Runtime or observer failure remains a job failure; no observer credential reaches the API.

The separate Compose Tasks job `101302400545` already passed Task seed/running/reloaded and stream running/reloaded verification in this CI run, as reported by root. The 40-case native stream gate also passed. Those are distinct from the failed general Compose memory observation step and are not rerun or claimed by this patch.

## Local checks on this correction

All commands used existing dependencies with `pnpm_config_verify_deps_before_run=false`.

| Command from `apps/api` unless noted | Actual result | Log |
| --- | --- | --- |
| `pnpm exec vitest run tests/integration/memory-*.test.ts tests/integration/memories.test.ts tests/integration/attachments.test.ts tests/integration/attachment-task-boundary.test.ts tests/unit/memory-input.test.ts --maxWorkers=4` | Exit 0; 49 tests across 12 files passed | `/workspace/scratch/2bc98607b3a9/mem01-native-fix-focused.log` |
| `pnpm run typecheck` | Exit 0 | `/workspace/scratch/2bc98607b3a9/mem01-native-fix-types.log` |
| `env -u TEST_MEMORY_DATABASE_URL pnpm_config_verify_deps_before_run=false pnpm exec vitest run tests/postgres/memories-runtime.test.ts --maxWorkers=1` | Exit 0; 14 discovered and skipped | `/workspace/scratch/2bc98607b3a9/mem01-native-fix-discovery.log` |
| Repository `pnpm exec prettier --write apps/api/tests/postgres/memories-runtime.test.ts` | Exit 0; already formatted | Tool output |
| Repository `git diff --check` | Exit 0 | Tool output |
| Repository `node --check infra/verify-memories.mjs` | Exit 0 | Tool output |
| Parse workflow YAML; extract exactly one memory smoke step; `bash -n` that exact step | Exit 0 | `/workspace/scratch/2bc98607b3a9/mem01-compose-observer-step.sh` |
| Execute that exact shell step with substituted Docker output, without services | Eight expected outcomes: exact audit succeeds; missing, duplicate, content-bearing audit, malformed or duplicate receipt fail; runtime exit 7 and observer exit 8 propagate | `/workspace/scratch/2bc98607b3a9/mem01-compose-observer-shell.log` |
| Repository `pnpm exec prettier --check apps/api/tests/postgres/memories-runtime.test.ts infra/verify-memories.mjs .github/workflows/verify.yml` | Exit 0 | Tool output |

The original native and general Compose failures are actual CI RED evidence. The local results are neither native nor Compose GREEN. Corrected runtime-role/lock/cleanup assertions and the real Compose observation still require a new CI run. No PostgreSQL, Docker, browser, or provider service was started, and no external gate is closed by this correction. Independent review and the dedicated root merger own incorporation.
