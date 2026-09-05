# Stream batch integration handoff

## Candidate and ownership

The isolated `integrate/stream-batch` branch starts at root `b869ef4a9c483dec8abefcd75c7a182a93308c74`. Root remains unchanged. This combined candidate is not accepted or published. The latest root metadata remains 24 complete, 4 in progress and 39 blocked across the original 67 tickets and 401 acceptance criteria.

Final source commit: `0ff6898eee671f04987fd5024a0bbc3c2d0afef4`, tree `3173dfcb6ea9af4913c0eae5fea67748a623dce2`. Both independent combination axes and the literal complete `pnpm verify` command passed on this unchanged source. Final counts and limits are in `STREAM-BATCH-VERIFICATION.md`; the complete shared-path map is in `STREAM-BATCH-CONFLICT-MAP.md`. This later evidence update changes documentation only.

| Component                               | Reviewed input                             | Integration checkpoint                     |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| COL-06 deterministic routing            | `9be9f17baba8cde4ec801b32ab091e36520f64fc` | `78864968b37dbfeb4b5604c4d506b55115aac149` |
| COL-09 manual failed-Task retry/history | `4c025e593cb2db80c767abe74896bac7344bd1c7` | `8b9972b50b213283b0a9aeec97b597ea9c763b42` |
| COL-05 complete ordered delivery        | `9425c6647869668bc6de9112349d69219cd40131` | `27d16d2260d8c64ea10123d5f35600e34d940e11` |
| MEM-01 complete stream/Save integration | `a6cf926075034ebbdb6891665973b4588fae36a5` | `0ff6898eee671f04987fd5024a0bbc3c2d0afef4` |

Each incorporated source input has independent Standards and Spec CLEAN results reported to root. Final combined Spec CLEAN came from `batch_spec_review`, and Standards CLEAN from `col06_web_standards`, both on exact `0ff6898` / tree `3173dfc`. MEM's exact reviewed source is `19568c9fc603b97213cd5560a097471ba93107fa`, tree `0f33d9b41358f50a67ebafc0c5f0e6a43fe625d1`; its later final pin changes documentation only. The optional routing projection delta also has its own completed independent reviews below.

## Intent preserved across conflicts

- Task summary/detail retains current attempt plus bounded history, retry command semantics and the optional small routing summary. Full routing evidence appears for only one explicitly selected Task. The shared failed-Task render regression proves that routing, current attempt/history and retry coexist.
- Final COL-05 codec, worker deadline rollback, retention/tail guards, authorized current-reference reader and real BFF streaming remain intact. Memory source checks remain inside fresh delta and final publication admission. No alternate sequence allocator or generic event writer was introduced.
- The existing native Tasks file combines root's CI-verified exact two-new-audit assertions with COL-05's exact human trigger, queued delivery/receipt and shared tail. Completed output is matched to the sole Bot event scoped by conversation and Run. COL-09 transaction cleanup and retry/routing cases remain present. These assertions were reconciled statically; native execution was not performed locally.
- API registration and browser scenario dispatch retain all stream, memory, routing, retry and public Bot families. Each browser scenario clears the real stream fixture before selecting a scenario handler.
- Final MEM's live Save memory map and bounded pending Save/edit snapshot now survive stream resets. The shared page retains this exact behavior alongside the independently selected routing section. The BFF validates the route group before creating memory and preserves the exact no-JavaScript search action grammar.

## Storage and deployment checks

The registry is the actual ordered 22-version prefix, ending with `0019_conversation_delivery`, `0020_group_source_memories`, `0021_deterministic_group_routing`, and `0022_failed_task_retries`. No predecessor schema was replaced or padded. A parsed machine comparison confirmed the Compose `migration_versions` literal equals this complete registry, after correcting an automatic-merge regression to 0019.

The current workflow contains all 14 combined jobs. Machine comparison retains all ten root non-Compose jobs exactly after YAML parsing, including the public Bot cases in `postgres-bots`. Both `postgres-conversation-streams` and `postgres-memories` exactly match their reviewed inputs; the running/reloaded stream stages and memory Compose check are present. The complete migration literal remains the actual 22-version registry after reconciling MEM's predecessor literal ending at 0020.

The runtime privilege script retains the delivery/floor/progress/receipt, memory, routing and retry tables with their scoped write permissions. The stream Compose running check precedes the existing Task running check; the reloaded stream check follows the existing Task history check. Both await API and Web readiness.

All ten files changed between accepted source `e51fafe4` and root `b869ef4a` were compared against root Git objects and remain byte-identical. The full issue directory and PROGRESS have no diff from root. The queue, existing native Tasks test, registry and runtime grants are unchanged from the already reconciled candidate. The pending-command helper, memory BFF, committed-response-loss browser cases, real stream fixture and memory Compose helper exactly match final MEM. No issue status or AC text changed.

## Verification and next actions

Intermediate checks passed: API/Web type checks, 26 routing/retry/Task API cases before COL-05 incorporation, 33 shared Task Web cases, and 25 stream/migration API cases after COL-05 incorporation. The optional routing delta has its own witnessed RED/GREEN record in `STREAM-BATCH-ROUTING-DELTA.md`; its affected selection then passed 62 API cases across thirteen files and 141 Web cases across ten files, plus API/Web types. These are interim checks, not a substitute for the final combined gate.

The exact routing delta `27d16d2260d8c64ea10123d5f35600e34d940e11..88b5d89503f596db2b40f4c2fd57b462fe94f037` subsequently received independent Spec and Standards CLEAN. This limited result does not accept the full combined candidate. Whole-tree lint passed; all 54 workflow Bash blocks parsed with `bash -n`, and the stream/task/runtime-grant infrastructure modules passed `node --check`. These syntax checks do not execute deployment gates.

The root-provided `docs/task-worker.md` update and a minimal README Task-section update now describe current routing, streaming/reconnect, manual same-Task retry/history and group memory. Original provider configuration and startup guidance remain intact. These documentation changes receive formatting and final unified review; no simulated tests were added.

After final MEM incorporation, all 57 workflow Bash blocks pass `bash -n`, and all four stream/task/memory/runtime-grant modules pass `node --check`. Four text conflicts were resolved: the actual 0022 registry, corresponding exact migration assertions, the complete Compose migration literal, and keeping both selected-routing and uncertain-command controls on the conversation page.

The complete single `pnpm verify` command exited 0: 1,453 non-browser cases, 53 ordinary browser scenarios, 1 OIDC scenario, lint, types and final API/Web builds. Both 4399/4173 sockets returned ECONNREFUSED after completion and the lease was explicitly released to root. No source changed during the command. Root acceptance, root fast-forward and publication remain root-owned; no local PostgreSQL/Docker or root worktree change was made. External PostgreSQL/Compose evidence remains separately required for the deployment gates.
