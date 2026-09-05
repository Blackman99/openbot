# COL-07 actual CI failure and narrow correction

## Exact publication and actual execution

[Verify33967009969](https://github.com/Blackman99/openbot/actions/runs/33967009969) ran from 2026-09-05 12:46:49 to 12:52:19 UTC and **failed: 13 of 16 jobs passed**. Remote `3d8a7e8010eb00d45c23df4d2e7a026c3c6ed046`, accepted local `d0c8c34291c256fb78222322da37b8a2b61c591b`, and the actual PR checkout `1c98fe036c6292d4c48cd42cc476e67b7bf6d0c0` have identical tree `c69ad62ce73cf04734bfc5e58e0c4f8ee1a59e7d`. Root verified the remote contents by fetch/diff and the checkout tree through the Git commit API.

The code job [101308805431](https://github.com/Blackman99/openbot/actions/runs/33967009969/job/101308805431) passed the complete literal verify: **1,504 nonbrowser tests (API 136 + 455; Web 180 + 733), 60 ordinary browser journeys, one signed OIDC journey, formatting/types and both builds**. Native PostgreSQL executed **251 passes and 20 failures**; skipped generic-job discoveries are not passes. Storage passed 14 cases. All three actual Compose jobs passed, including the new cancellation job.

| Failed job | Actual result and cause |
| --- | --- |
| [postgres-task-cancellation 101309208756](https://github.com/Blackman99/openbot/actions/runs/33967009969/job/101309208756) | 18 failures. The first populated legacy upgrade correctly rejected a running Run, then failed its explicitly drained upgrade with SQLSTATE `55006`: `cannot ALTER TABLE "tasks" because it has pending trigger events`. The whole migration rolled back. The following 17 cases consequently encountered absent 0023 columns/tables; these are not 18 independent diagnosed production defects. |
| [postgres-tasks 101309208702](https://github.com/Blackman99/openbot/actions/runs/33967009969/job/101309208702) | 39/40 passed. A raw expired final INSERT was rejected by the new earlier cancellation publication fence with SQLSTATE `55000`, message `only the current live Run can publish`; the test still expected the preceding guard's `23514`. |
| [postgres-conversation-streams 101309208851](https://github.com/Blackman99/openbot/actions/runs/33967009969/job/101309208851) | 39/40 passed. The real progress-write wait crossed the persisted deadline; the new durable-partial guard rejected the next checkpoint with `23514` before the existing application tail check could report typed `execution_timeout`. |

The populated upgrade uncovered a production deployment defect despite successful empty-volume and historical pre-auth Compose upgrades. The migration failure retained the old ledger and schema atomically; it did not partially apply 0023.

The successful native jobs were auth16, providers5, OIDC1, Bot108 (8+9+8+11+24+17+31), conversations10, group-Bots14, attachments5 and memories14. The Task and stream files each contributed 39 passes. Their total is 251, excluding the 20 failed cases and all discovery skips.

The new [compose-task-cancellation 101309208707](https://github.com/Blackman99/openbot/actions/runs/33967009969/job/101309208707) passed seed at 12:50:56 UTC, cancel at 12:51:03 and reloaded at 12:51:05: separate-worker queued prevention, real streaming/silent HTTP abort, and retained interrupted output after process restart and stream reclamation. [compose-tasks 101309208696](https://github.com/Blackman99/openbot/actions/runs/33967009969/job/101309208696) passed all Task/stream seed/running/reloaded stages; [general Compose 101309208829](https://github.com/Blackman99/openbot/actions/runs/33967009969/job/101309208829) passed all prior fresh/upgrade/runtime/application/outage checks through 0023. These successes do not close the failed native gate.

## Correction and preserved behavior

Correction source **`ac03de5484b43773c37d67756e3fedebb2640437`**, tree **`4833173b98b3aa35c46c1e6a2a80407bcab5bf03`**, is based on `38fbf8f327eadefb0428b4365e6ca7395ac3e493`. Its exact four-file delta has independent Spec and Standards **CLEAN** reviews by `/root/bot_copy_lifecycle_spec` and `/root/col06_web_standards`.

1. The migration executor gives only unapplied PostgreSQL migration 0023 a named temporary constraint mode. After the existing exclusive-lock/drain preflight, `tasks_current_run_required` validates the root backfill immediately, so no pending event remains before the following ALTER TABLE. The same transaction restores that named constraint to DEFERRED after the schema phase, before the remaining guards and later migrations. Ordinary applied-version skipping, the migration transaction/rollback and all other constraints remain intact. The original 0023 schema/guard statements and runtime grants are byte-for-byte unchanged; no migration number or ledger entry is inserted or rewritten.
2. The delta writer checks the retained deadline immediately after the awaited progress write and before attempting a durable checkpoint. Expiry returns through the existing `TaskPublicationError('execution_timeout')` path, whose caller rolls back the complete delta/progress/sequence transaction. The existing final check after retention and all PostgreSQL fences remain. No broad SQL exception is swallowed or reclassified.
3. The raw expired-output native assertion requires the actually reached `55000` and its exact fence message. Its subsequent retained timeout/usage and zero-output assertions remain. The real stream wait's original typed timeout and complete-snapshot rollback assertions are unchanged.

## RED, GREEN and remaining gate

The real CI above is the RED witness for populated upgrade and both native boundaries. A new actual TaskQueue integration case also reproduces the progress-wait boundary with an explicit database fault substitute: before the production correction it failed `23514` versus expected `execution_timeout` (one failed, two passed). After correction it reports the typed timeout without attempting any partial checkpoint. Its pg-mem fixture is not claimed to prove native transaction rollback; the unchanged real PostgreSQL wait case is the final rollback witness.

From the isolated correction worktree, with `pnpm_config_verify_deps_before_run=false` on every pnpm command:

- `pnpm --filter @openbot/api exec vitest run tests/integration/task-partial-output.test.ts tests/integration/migrations.test.ts tests/integration/task-worker.test.ts tests/integration/task-cancellation.test.ts`: **4 files, 38 tests passed**, exit 0.
- API `typecheck`, API `build`, then repository `lint`: all exit 0, sequential. Diff/format checks passed.
- No local PostgreSQL, Docker or browser server was started for this correction; no new literal local full-verify success is claimed for the changed source.

A new actual CI run must pass all 18 cancellation native cases and both retained deadline regressions, while keeping the other jobs green, before COL-07-E1 closes. Its already successful independent-process cancellation stages are retained evidence, not a substitute for the failed populated upgrade. COL-07 stays `complete-with-external-verification`; all original 401 requirement texts and other ticket statuses are unchanged.

## Retained log fingerprints

Paths are under `/workspace/scratch/2bc98607b3a9`. GitHub log hashes identify the saved UTF-8 copies, with CRLF normalized and a terminal newline; they do not assert the raw download's byte encoding.

| File | SHA-256 |
| --- | --- |
| `ci339670-job-101309208756.log` | `357e541b32596b1caa5c8e1f3cf140befeda391ab332190c2c618689871999d0` |
| `ci339670-job-101309208702.log` | `7bdc316e4fcbd56da89fb824bfa0b36927d8ec93a3239d6cd4eb696460edc2e9` |
| `ci339670-job-101309208851.log` | `aa6f29c1d60739389ca3d5150c0362bb4128673016ceba83173232f594651dbb` |
| `ci339670-job-101308805431.log` | `f62ecfd13efeda627560730bc9415db780e69a7702fba2708175fc047f2a0ad9` |
| `ci339670-job-101309208707.log` | `1d128f95b323b43acedfa4a4fc236a1dc0a56139802051d4ae8ce6f97bf4cf3d` |
| `col07-ci-delta-red.log` | `65423da350414ac191fd2702b2b9dd1f04b04c60bcca5a0536746519788db69f` |
| `col07-ci-focused-green.log` | `d0ec533e962c423184917443cd66fe1e5424fb153af2665aa3ff32edc68a11d3` |
| `col07-ci-types-build.log` | `b241313ba58b24387626363f96d01a6553181a81d3cda595bb5fa45019a6a5b3` |
