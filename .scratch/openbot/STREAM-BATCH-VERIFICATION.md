# Stream batch final verification

Verified and independently reviewed source commit: `0ff6898eee671f04987fd5024a0bbc3c2d0afef4`.
Exact source tree: `3173dfcb6ea9af4913c0eae5fea67748a623dce2`.
Root baseline remains `b869ef4a9c483dec8abefcd75c7a182a93308c74`.
The subsequent integration evidence changes Markdown only and do not change this verified production/test source.

## Complete command

Working directory: `/workspace/scratch/2bc98607b3a9/openbot/.worktrees/integrate-stream-batch`.

```sh
pnpm_config_verify_deps_before_run=false pnpm verify
```

This literal single command ran formatting, types, all unit tests, all integration tests, the ordinary browser suite, the separate OIDC suite and final production builds in repository order. The executor process/session `11166` returned **exit code 0**. The complete log is `/workspace/scratch/2bc98607b3a9/stream-batch-verify.log`. The environment setting only prevents dependency reconciliation in the shared installed dependency tree; it does not disable any verification stage.

Log SHA-256: `de97c4b2bcf28378f837b437e867882806aa68e3dd0fa4d027bb13eccf79ea45`.

| Stage             | Actual completed result                        |
| ----------------- | ---------------------------------------------- |
| Formatting        | All matched files use Prettier style           |
| API types         | Passed                                         |
| Web types         | Zero errors and zero warnings                  |
| API unit          | 130 passed across 23 files                     |
| Web unit          | 167 passed across 27 files                     |
| API integration   | 439 passed across 69 files                     |
| Web integration   | 717 passed across 50 files                     |
| Total non-browser | **1,453 passed**                               |
| Ordinary browser  | **53 passed**, one worker                      |
| OIDC browser      | **1 passed**, separate configuration           |
| Final builds      | API TypeScript and Web production build passed |

There were no failures, source fixes or reruns in this final combined command. Earlier feature and focused checks are not added to these totals. The command exercised the real BFF stream journeys, current streamed human/Bot Save, no-JavaScript memory search, original-key Save/edit retries after committed response loss and stream expiry, selected routing, bounded Task attempt history/manual retries and the public Bot round trip together.

Before and after the command, `git diff --exit-code 3173dfcb6ea9af4913c0eae5fea67748a623dce2 --` returned 0. Completing the Git merge during the run did not change that tree. Only the three intentionally untracked dependency symlinks remained in worktree status.

## Independent review and preserved inputs

Root reported Spec CLEAN from `batch_spec_review` and Standards CLEAN from `col06_web_standards` on exact source commit `0ff6898` / tree `3173dfc`. The reviews cover the combination, shared conflict resolutions, the bounded routing projection adaptation, final pending-command behavior and current-feature documentation. Each incoming COL-05, COL-06, COL-09 and MEM-01 source also had both original independent axes CLEAN. The exact source pins and all shared conflict paths are recorded in `STREAM-BATCH-INTEGRATION.md` and `STREAM-BATCH-CONFLICT-MAP.md`.

The optional routing projection additionally has its own witnessed RED/GREEN and independent reviews on `27d16d2260d8c64ea10123d5f35600e34d940e11..88b5d89503f596db2b40f4c2fd57b462fe94f037`. Its already-passing focused cases are included in the full totals above.

Machine comparison of the final combined source confirmed:

- Actual 22-version registry equals the full Compose migration literal, ending in real 0019 delivery, 0020 memory, 0021 routing and 0022 retries.
- All **14 workflow jobs** remain. The ten original non-Compose jobs match root after YAML parsing, including the public Bot test selection; the two new native jobs match their reviewed feature inputs.
- Both running/reloaded stream Compose stages and the scoped-memory Compose stage remain. The deployed runtime grants include delivery, memory, routing and retry permissions.
- The queue, existing native Tasks file, registry and runtime grants exactly match the earlier reconciled candidate. The native Tasks assertions preserve root's exact audit facts plus queued delivery/receipt and sole scoped output facts.
- The pending-command helper, memory BFF, committed-response-loss browser cases, real stream fixture and memory Compose helper exactly match final MEM. The shared page adds only the routing import/navigation/selected section to final MEM's complete page.
- All 57 workflow Bash blocks pass `bash -n`; all four stream/task/memory/runtime-grant infrastructure modules pass `node --check`.
- Every original issue and PROGRESS matches root. All ten files carrying the latest root acceptance/CI metadata remain byte-identical. Root separately compared the original 67 tickets' 401 AC checkboxes with `b29e5f5` and reported no changes.

## Browser lease and remaining boundary

After the full command exited, bounded TCP connections to `127.0.0.1:4399` and `127.0.0.1:4173` both returned **ECONNREFUSED**. Both ports were explicitly released back to root. No service remains running from this verification worktree.

No local PostgreSQL or Docker was provisioned. The new stream suite has 40 authored native cases and the memory suite has 14; their real PostgreSQL execution and real Compose stream/memory checks remain external CI gates. Local pg-mem, browser, syntax and source review results do not prove native locks, guards, deployed least privileges or Compose operation. Existing native and object-storage jobs remain configured for the complete combined CI run; their older accepted baseline evidence is not a fresh execution of this tree.

Root acceptance, root fast-forward, metadata updates and publication remain separate steps. This merger did not change the root worktree or push any branch.
