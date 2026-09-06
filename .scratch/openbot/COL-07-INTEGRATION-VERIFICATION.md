# COL-07 dedicated integration verification

## Frozen source and scope

The dedicated merger combined accepted root `ae41c6a2bc0b624202cd5a4ea506f90779e9e0b2` with the independently reviewed final COL-07 candidate `fc03c7b4d345ca9fc3cf8c59cd53b6c74ea82799` in `integrate/col07`. Merge source commit **`49d24d8b2ab81b2e2fe47fcf4f474ff66785c36b`** has tree **`2380e6e2148d109aec227958b69dc78849ca4369`**. The merge base is `0ff6898eee671f04987fd5024a0bbc3c2d0afef4`.

All application, infrastructure, workflow, user documentation and manifest blobs exactly match final author `fc03c7b4d345ca9fc3cf8c59cd53b6c74ea82799` (source `fb38a4e90702f03aeb7d55ded8400ad139c31929`). There is no integration source adaptation. The complete issues directory, PROGRESS, existing closure records and frontier handoffs retain accepted root blobs. All 67 original tickets and 401 acceptance texts match original `b29e5f5`; ticket statuses were left for root acceptance. Relative to root, existing metadata is unchanged and only the two author COL-07 handoff/evidence documents are added in this source merge.

Independent whole-ticket Spec (`/root/bot_copy_lifecycle_spec`) and Standards (`/root/col06_web_standards`) are CLEAN at final author `fc03c7b4`, tree `6282d0c603441ec0126fc24dae2cb949120294bf`. Root independently reviewed the immutable combined tree `2380e6e2148d109aec227958b69dc78849ca4369` and reported the integration delta CLEAN before the full gate completed.

## Exact conflict resolution

The only conflict was an add/add of `STREAM-BATCH-CI-FIX.md`, absent from the merge base. No source conflict occurred.

| Stage            | Blob                                       | Intent                                                         |
| ---------------- | ------------------------------------------ | -------------------------------------------------------------- |
| 2: accepted root | `ae0b46e57e1b0a33f6766bbb5781419de00d1bdd` | Historical fix evidence plus independent acceptance record     |
| 3: author        | `5eaf3d6aecd40d070211bd3da2603a12b12b667c` | The same historical fix evidence without the accepted addendum |
| Resolved         | `ae0b46e57e1b0a33f6766bbb5781419de00d1bdd` | Preserve the exact root superset                               |

A byte comparison proved stage 3 is the exact prefix of stage 2; the additional 602 bytes are root's independent acceptance section. Automatic workflow and Task native-test merges also match the reviewed author blobs. The Task native assertion retains the accepted typed five-audit facts and privileged observer, with only the reviewed current final-Run locator relative to root.

## One complete merger gate

On 2026-09-05, the resolved tree remained fixed throughout this exact command:

```sh
pnpm_config_verify_deps_before_run=false pnpm verify
```

**Actual exit 0**, exec session `94241`; the shell recorded the same zero exit in `col07-integration-verify.exit`. The merge commit was created only after the gate completed and the tree was rechecked.

| Gate                          | Actual result        |
| ----------------------------- | -------------------- |
| API unit                      | 136 passed           |
| API integration               | 455 passed           |
| Web unit                      | 180 passed           |
| Web integration               | 733 passed           |
| Total nonbrowser              | **1,504 passed**     |
| Ordinary browser              | **60 passed**        |
| Signed OIDC browser           | **1 passed**         |
| Formatting and API types      | Passed               |
| Web types                     | 0 errors, 0 warnings |
| API and Web production builds | Passed               |

The 60 ordinary cases include seven real cancellation journeys: queued prevention, active HTTP abort with retained escaped prefix, current administrator stopping, access revocation, unknown committed response confirmation, stale-Run refresh, and silent-request abort before its first byte. Existing live memory/edit response-loss recovery, routing, retry/history and all other ordinary journeys passed in the same command.

Log: `/workspace/scratch/2bc98607b3a9/col07-integration-verify.log`

SHA-256: `27e2de98d2bb62163aaafb130c5c22f226a51f41548c3bca33a6508c754a6718`

Exit file SHA-256: `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa`

Before the full gate, format and sequential Web/API type checks also exited zero. Structural checks parsed workflow and Compose YAML with unique keys, syntax-checked all workflow shell bodies and five changed JavaScript files, and verified the 23 migration registry entries exactly equal the deployed Compose literal through `0023_task_tree_cancellation`. The workflow has 16 jobs: all 14 inherited jobs remain deeply identical after normalizing the sole new migration suffix, with `postgres-task-cancellation` and `compose-task-cancellation` added. Existing public Bot, memory/stream native jobs, accepted memory audit observer and prior Compose stages are preserved.

Machine records are alongside the log: `col07-integration-source-freeze.json`, `col07-integration-merge-stages.json`, `col07-integration-structure.json`, `col07-integration-workflow.json` and `col07-integration-verify-result.json`.

## Evidence boundaries and handoff

The author's original `6779a035` full gate remains an exit-1 historical run: 1,492 nonbrowser and 59/60 ordinary cases passed, and its obsolete queued cancel-button assertion stopped OIDC/build. Its repaired browser/build and focused UTF-16/client results remain recorded in [author evidence](COL-07-IMPLEMENTATION-EVIDENCE.md). This dedicated merger's single complete exit-zero run is the combined-source gate; it does not relabel that earlier failure.

This local gate did not execute PostgreSQL or Docker. The 18 authored native cancellation cases and the new separate-process cancellation Compose job still require actual CI execution; discovery/skips are not native passes. Root's historical Verify33965537394 success and closure of the four prior stream/routing/retry/memory gates remain unchanged and do not constitute execution of the new cancellation cases.

The verify process exited, and both `4399` and `4173` returned TCP `connect_ex=111` at `2026-09-05T12:39:48.891122+00:00`. The merger explicitly released both browser ports. Root remained tracked-clean at `ae41c6a2bc0b624202cd5a4ea506f90779e9e0b2`. No root edits, publication, PR changes, local PostgreSQL or Docker operation were performed by this integration.
