# COL-04 native duplicate-submission audit correction

Base: `cb9977374ff2b3d40ebb9b5783647d99c32cfcb1`, the accepted COL-04 tree
published as `60afa3b3ce2c97bb36d2aeb0100c4b97d1669ae0`.

## Observed native RED

On 2026-09-05, Verify run
[33958220385](https://github.com/Blackman99/openbot/actions/runs/33958220385),
job [101285528478](https://github.com/Blackman99/openbot/actions/runs/33958220385/job/101285528478),
executed the 26 PostgreSQL Task cases: 25 passed and one failed. The duplicate
submission case failed at `tasks-runtime.test.ts:466` with an expected audit
length of 2 and actual length of 3. The job checked out PR merge
`78f845dac49e35b58001cf0caa8e0172ae63bdc4`, combining the published head with main.

The snapshot deliberately includes every audit whose metadata names this
conversation. The fixture opens the conversation through the production
repository before starting the competing submissions. That operation records
one `conversation.created` audit. A successful Task submission then records
exactly one `conversation.message_created` audit for its human trigger and one
`task.queued` audit for its first Run. The replay adds none. The failing assertion
counted all three records while expecting only the two submission records.

## Corrected invariant

The test now validates the initial conversation audit and retains that complete
record, including its ID, in the final snapshot. It requires exactly two added
audits and checks both event types, the actual human actor, workspace and
conversation IDs. The trigger audit must name the returned message/event/sequence;
the queued audit must name the returned Task/Run/trigger, pinned Bot version and
attempt 1. Missing, extra, duplicated or mismatched audits fail these assertions.

The snapshot query is unchanged. The observed PostgreSQL lock barriers, equal
duplicate receipts, conflict rejection, one Task/Run/trigger, sequence 1,
reconstructed reads, cross-scope rejection and audit-rollback cases are unchanged.
No production source, migration, privileges, workflow or fixture behavior changes.

## Local evidence and remaining gate

- A production-service probe using pg-mem reproduced the old assertion's RED:
  baseline `[conversation.created]`; final event types
  `[conversation.created, conversation.message_created, task.queued]`; `3 !== 2`.
- The same unchanged service sequence passed the corrected invariant, preserving
  the baseline audit verbatim and matching the two added audits to committed IDs.
  This was a sequential replay probe, not native concurrency evidence.
- Focused API verification passed: four files / 18 tests. Native discovery
  registered 26 cases and explicitly skipped all 26 because
  `TEST_TASK_DATABASE_URL` is absent. Those skips are not passing native evidence.
- API TypeScript, changed-file formatting and `git diff --check` passed.
- The isolated worktree reused installed dependencies and generated its own
  Svelte configuration before the cross-package Web contract tests. No service
  was provisioned and no browser ports were used.

Verification command:

```sh
pnpm_config_verify_deps_before_run=false pnpm --filter @openbot/api exec vitest run tests/integration/tasks.test.ts tests/integration/task-worker.test.ts tests/integration/task-schema.test.ts tests/integration/task-web-contract.test.ts tests/postgres/tasks-runtime.test.ts --maxWorkers=1
```

The corrected PostgreSQL case still requires actual execution after integration
and publication. This note does not close that gate or claim a new Compose run.
