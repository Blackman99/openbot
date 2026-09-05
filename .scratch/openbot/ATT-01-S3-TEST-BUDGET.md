# ATT-01 real S3 acceptance case budget

Base: `675fd53c0ac098abac05a1560ce339abd7ae9df1`, published as
`2dab3fc280654257ba5a516c207ab8e2ba929e6a` with tree
`c790bdb0e4b0fb61154752352652a94715a8ad38`.

## Observed CI failure

On 2026-09-05, [Verify 33959031255](https://github.com/Blackman99/openbot/actions/runs/33959031255)
finished at 09:54:57 UTC. Eleven jobs passed. The sole failure was
[object-storage job 101287771358](https://github.com/Blackman99/openbot/actions/runs/33959031255/job/101287771358),
which completed at 09:53:12 UTC.

`tests/s3/object-store.test.ts:36` reported `Test timed out in 5000ms` for
`keeps attachment and avatar byte bounds independent on the real backend`.
Vitest reported 7,823 ms for that case. The other 13 cases passed: seven local
store cases and six real S3 cases, including unsigned-read denial. This log
does not establish whether network work or the large byte comparison dominated
the elapsed time, and it does not prove the failed case's assertions completed.

## Bounded correction

Only that existing case gets a 30,000 ms test budget. It performs a 3 MiB PUT,
GET with exact byte comparison, independent avatar-size rejection, and a DELETE
in its existing cleanup block. Each remote store operation still has its own
10,000 ms deadline through `objectOperation` and the SDK request handler. A
5,000 ms budget for the whole case can expire before those operations finish.

The payload, exact byte equality, avatar-size rejection and cleanup are
unchanged. Other tests still verify immutable keys, concurrent collisions,
read/write bounds, traversal rejection, pre-aborted operations and private
access. Production code, checksum handling, operation deadlines, socket
configuration, `maxAttempts: 1`, workflow configuration and global test budgets
are unchanged. No retry or local S3 service is introduced.

## Local verification and remaining gate

The focused command below passed seven local-store cases and discovered seven
explicitly skipped real-S3 cases because `TEST_S3_ENDPOINT` is absent. Changed
test formatting and `git diff --check` passed. No native S3 GREEN is claimed.
Actual CI must rerun the unchanged real-backend assertions before ATT-01-E1
can close.

```sh
pnpm_config_verify_deps_before_run=false pnpm --filter @openbot/api exec vitest run tests/integration/local-object-store.test.ts tests/s3/object-store.test.ts --maxWorkers=1
```

The preceding run already passed all five attachment PostgreSQL cases and the
general Compose private upload/download/durable-purge acceptance. Those results
do not replace the remaining real-S3 case.

## Actual CI retry completed

[Verify33960029570](VERIFY-33960029570.md), completed2026-09-05 at10:17:34 UTC, passed all12 jobs on the exact accepted local `e51fafe4` tree. Object-storage job101290513259 ran all seven real-S3 and seven local-store cases successfully; the unchanged large-file case passed at10:15:52.1138953 UTC in **7,713 ms**. The same run passed PostgreSQL attachment5/5 and deployed private attachment Compose/purge. This actual retry closes ATT-01-E1; it does not relabel the earlier local skips or default-budget failure.
