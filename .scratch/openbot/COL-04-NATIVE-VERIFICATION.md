# COL-04 native PostgreSQL verification

Native helper base: `e0b4af9bc8029ace9caf937d8c950028174242f4`.
Integrated core pin: `d609b63b9618c940d3275157bb7d85249dad9e96`, a descendant of
the core author's schema/privilege pin `a5c094b096666127bffe0f42fea8e1a395b2d285`.
It includes accepted BOT-06 migration `0016_bot_lifecycle`,
`0017_single_bot_tasks` and the expired-claim-before-I/O fix. The helper merged
this exact dependency in its isolated worktree before the final checks below.

Scope: `apps/api/tests/postgres/tasks-runtime.test.ts` and the isolated
`postgres-tasks` Verify job. Production schema, runtime grants, worker entry
point and Compose belong to the core implementation.

## Native execution gate

The suite requires `TEST_TASK_DATABASE_URL` pointing at a dedicated disposable
PostgreSQL database. It executes `migrateDatabase(admin)` with the real
PostgreSQL guards enabled, checks that both 0016 and 0017 were applied, and runs
the production runtime-role provisioner. All services and worker calls use
`openbot_runtime`. The migration connection is used only for inspection,
adversarial owner-level writes, controlled audit failure injection and fixture
cleanup through permitted terminal transitions.

There is no provisional task schema, placeholder migration, local database
startup or Docker invocation in this helper. The provisioner rotates a fixed
role password, so the workflow uses its own `openbot_tasks_test` PostgreSQL
service and runs only this suite. Readiness uses an authenticated bounded SQL
query against the named database.

Provider capability checks and adapter responses are deterministic fixtures.
The suite tests real SQL, permissions, migrations, transaction boundaries and
locking; it does not claim upstream provider transport evidence. Reconstructed
services and worker pools test persistence across disconnected clients. The
actual separate OS worker/Compose process gate belongs to the core integration.

## Case map

| Cases | Contract and observable evidence |
| ---: | --- |
| 1 | Exact table/column/function privileges; retained Task/Run identities even for the migration owner; matching Run status; attempt-one restriction; cross-workspace Task rejection; exact admitted model binding. |
| 1 | Two submissions blocked on an observed workspace lock return one identical Task/trigger/Run and two mandatory audits; mismatched command reuse fails; new pools reconstruct get/list results; direct creator and workspace isolation hold. |
| 4 | Final `task.queued`, `task.running`, `task.completed` and `task.failed` audit failures roll back complete before/after snapshots, including sequence, events, Tasks, Runs and earlier audits; the unchanged operation succeeds after removing the fault. |
| 1 | An ordinary group member without direct Bot ACL uses only the shared provider; the exact future-only grant excludes a real earlier message from model input; running claim/token/deadline/provider revision persist before I/O; even a complete callback cannot publish before the whole promise resolves; final output has pinned Bot authorship and no human mutation controls; cumulative usage is 5/3, not summed snapshots; reconstructed pools retain results. |
| 2 | A rejected provider promise or terminal error after text/usage/complete callbacks persists failure and actual usage, with no Bot output or provider error text in the DTO/audits. |
| 1 | Competing claims and completions traverse observed lock chains, yielding one claim and one final output; stale tokens are inert; claim/provider identity and terminal output are immutable; raw and service-level human edits/deletions cannot rewrite Bot output. |
| 1 | Failed Task/Run rows cannot reopen, and late completion cannot fabricate output. |
| 2 | Workspace or Bot ACL removal while a replay waits denies both that replay and a later new command, retaining the existing snapshot. |
| 6 | Disabling the personal provider or changing its model ID during an observed provider-policy wait reauthorizes submit, claim and finish; rejected admission creates no trigger; rejected claim/finish records failure without output. |
| 1 | A persisted expired claim cannot publish even a canonically attributed raw Bot event through the PostgreSQL guard; conditional finalization records `execution_timeout` and usage without output. |
| 1 | Submission reads the version after its workspace lock wait; later current-version changes cannot alter the stored pin, context instructions or final Bot author. |
| 2 | Removing the actual triggering group member while claim/finish waits causes `execution_forbidden`; retained task inspection remains available to the group owner. |
| 2 | Closing the exact grant while claim/finish waits causes failure; a later grant for the same Bot cannot replace that retained grant or revive its Task; retained history stays readable. |
| 1 | A group member cannot borrow the grantor's personal provider; rejection leaves no Task, Run, trigger or audit side effects. |
| **26** | **Native cases; execution remains an external gate until the dedicated PostgreSQL job passes.** |

Concurrency barriers use `pg_stat_activity`, `wait_event_type='Lock'` and a
recursive traversal of `pg_blocking_pids`. A waiter may be queued behind another
waiter; the tests require an observed path to the held lock, not a direct edge
from every contender to the original PID. Promise rejections are observed
before awaiting barriers; all holders and client pools are released in finally
blocks. No arbitrary sleep is used to establish a race.

## Local checks

- API typecheck: passed with the new native suite and integrated core dependency.
- Existing task/schema/worker integration baseline: 3 files, 15 tests passed;
  after integrating the actual migrations and deadline fix: **3 files, 16 passed**.
- Native discovery: 1 file, **26 skipped**, exit 0, because
  `TEST_TASK_DATABASE_URL` is not configured. This is not native passing evidence.
- Workflow YAML parsed successfully; the unique database, dedicated URL,
  authenticated SQL readiness and exact native test command were asserted.
- Formatting and `git diff --check`: passed.

Focused integrated command:

```sh
pnpm_config_verify_deps_before_run=false pnpm --filter @openbot/api exec vitest run tests/integration/tasks.test.ts tests/integration/task-worker.test.ts tests/integration/task-schema.test.ts tests/postgres/tasks-runtime.test.ts --maxWorkers=1
# 3 files passed, 1 file skipped; 16 passed, 26 skipped; exit 0
```

Commands use `pnpm_config_verify_deps_before_run=false` with the already installed
shared dependencies, avoiding pnpm's unrelated worktree dependency
reconciliation. No package manifest or lockfile is changed.

The unified COL-04 review and dedicated merger own the independent Standards and
Specification review, complete verification, real native execution and Compose
gate. Local skips do not close those gates.
