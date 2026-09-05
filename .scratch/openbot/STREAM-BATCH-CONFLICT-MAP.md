# Frozen stream-batch conflict map

Worktree: `/workspace/scratch/2bc98607b3a9/openbot/.worktrees/integrate-stream-batch`.
Frozen combined tree: `3173dfcb6ea9af4913c0eae5fea67748a623dce2`.
Final source merge commit `0ff6898eee671f04987fd5024a0bbc3c2d0afef4` combines prior candidate `c723f8a2a79e6870b90b80ace40c0bd865b72671` with final MEM `a6cf926075034ebbdb6891665973b4588fae36a5`. Complete `pnpm verify` passed against this unchanged source tree; this later tracked conflict map changes documentation only. See `STREAM-BATCH-VERIFICATION.md` for the completed gate and review boundary.

## COL-06 plus COL-09

The COL-06 merge `78864968b37dbfeb4b5604c4d506b55115aac149` was conflict-free. The following four conflicts were resolved in COL-09 merge `8b9972b50b213283b0a9aeec97b597ea9c763b42`.

| Path                                                                                                          | Combined intent                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/components/TaskSummary.svelte`                                                              | Small routing reason/link plus current attempt, bounded history link and Run component.               |
| `apps/web/src/lib/server/task-contract.ts`                                                                    | Strict optional routing summary plus exactly one current Run, runCount and olderRunsCursor.           |
| `apps/web/src/lib/server/task-page.ts`                                                                        | One explicitly selected routing decision plus requester/current-rights retry form and history loader. |
| `apps/web/src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/tasks/[taskId]/+page.svelte` | Selected routing evidence alongside manual retry and uncertain-response confirmation.                 |

The auto-merged Task tests were checked. `apps/web/tests/unit/task-routing-pages.test.ts` required the newly mandatory retry fixture fields; one added combined render case verifies failed attempt 2, history, retry identity and exactly one candidate panel together.

## Complete COL-05

The following twelve conflicts were resolved in merge `27d16d2260d8c64ea10123d5f35600e34d940e11` from complete COL-05 `9425c6647869668bc6de9112349d69219cd40131`.

| Path                                                                                           | Combined intent                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.scratch/openbot/COL-05-API-CONTRACT.md`                                                      | Final COL-05 source-reference, bounded-delivery and deadline/tail-guard contract.                                                                                                   |
| `apps/api/src/app.ts`                                                                          | Both Memory and conversation-stream registrations alongside routing/retry/public Bot families.                                                                                      |
| `apps/api/src/conversations/stream-schema.ts`                                                  | Complete 0019 deferred conversation-tail update guard.                                                                                                                              |
| `apps/api/src/database/migrations.ts`                                                          | Actual ordered 0019, 0020, 0021 and 0022 with their real guards.                                                                                                                    |
| `apps/api/src/tasks/queue.ts`                                                                  | MEM fresh-source checks inside delta/final admission plus final COL-05 deadline rollback.                                                                                           |
| `apps/api/src/tasks/service.ts`                                                                | Original routing decision, retry semantics and typed queued writer after decision persistence.                                                                                      |
| `apps/api/tests/helpers/bot-acl-fixture.ts`                                                    | Both database and auth helpers required by stream and public Bot cases.                                                                                                             |
| `apps/api/tests/integration/conversation-stream-storage.test.ts`                               | Final mandatory-guard cases and exact registry prefix before 0019.                                                                                                                  |
| `apps/api/tests/integration/migrations.test.ts`                                                | Exact actual 22-version registry and tables, latest 0022.                                                                                                                           |
| `apps/api/tests/postgres/tasks-runtime.test.ts`                                                | Root's CI-verified two-new-audit facts, sole human trigger, exact queued delivery/receipt/tail, sole scoped Bot output, routing/retry native cases and transactional cleanup.       |
| `apps/web/src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/+page.svelte` | Full stream lifecycle/current-message rendering plus group memory/routing navigation and one selected routing section. Final MEM subsequently supplies Save/edit pending snapshots. |
| `apps/web/tests/e2e/fixture-api.mjs`                                                           | Clear stream fixture before every scenario; retain real stream, routing, public Bot and memory handlers.                                                                            |

`.github/workflows/verify.yml` auto-merged with a stale 0019 Compose literal. That concrete contradiction was corrected to the actual 22-version prefix. The source/native guard was not weakened.

## Approved routing projection adaptation

The exact delta `27d16d2260d8c64ea10123d5f35600e34d940e11..88b5d89503f596db2b40f4c2fd57b462fe94f037` already has independent Spec and Standards CLEAN. Three production files change: `apps/api/src/conversations/stream-protocol.ts`, `apps/api/src/tasks/execution-state.ts`, and `apps/web/src/lib/conversation-stream-contract.ts`. Only optional immutable algorithm/reason are projected from the same group Task/workspace/conversation; strict legacy compatibility, no extra request and no new allocator. New API bootstrap/resume/retry behavior and strict Web cases were witnessed RED/GREEN. See `.scratch/openbot/STREAM-BATCH-ROUTING-DELTA.md` in the candidate.

## Final MEM merge

Final input `a6cf926075034ebbdb6891665973b4588fae36a5` has reviewed source `19568c9fc603b97213cd5560a097471ba93107fa` / tree `0f33d9b41358f50a67ebafc0c5f0e6a43fe625d1`; its later change is documentation only. Exactly four final text conflicts were resolved.

| Path                                                                                           | Final resolution                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/verify.yml`                                                                 | Retain full actual 0022 literal; add exact reviewed memories job/check while retaining stream job/stages and all root jobs.                                                                     |
| `apps/api/src/database/migrations.ts`                                                          | Retain the real 0021 and 0022 after MEM's real 0020. No file diff from preceding candidate.                                                                                                     |
| `apps/api/tests/integration/migrations.test.ts`                                                | Retain exact registry and latest 0022 assertions. No file diff from preceding candidate.                                                                                                        |
| `apps/web/src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/+page.svelte` | Keep both selected-routing and uncertain-command sections with separate conditions. Against final MEM the entire page differs only by the routing import, navigation link and selected section. |

Machine comparison confirms the pending-command helper, memory BFF, command retry browser cases, real stream fixture and memory Compose helper exactly match final MEM. Queue, existing native Tasks file, migration registry and runtime grants exactly match the previously reconciled candidate. The four final conflicts introduce no new domain behavior.

## Other integration deltas and checks

`e05eabbe1e193a70adb63304320132cc6a3d18fa` records the limited routing review boundary. `c723f8a2a79e6870b90b80ace40c0bd865b72671` updates README and `docs/task-worker.md` for current features while preserving provider configuration guidance; root read these documentation changes CLEAN. The final staged handoff updates the actual input map and machine checks only.

All 14 workflow jobs are present. The original ten non-Compose jobs match root exactly after YAML parsing, including public Bot tests; the two new jobs match their reviewed feature inputs. The actual 22-version registry equals the Compose literal. Both running/reloaded stream stages and memory stage remain. All 57 Bash blocks parse; four infrastructure modules pass syntax checks. Every original issue and PROGRESS matches root b869, and all ten files carrying root's latest accepted metadata remain byte-identical. Native PostgreSQL and real Compose execution remain external; no local service was provisioned for those gates.
