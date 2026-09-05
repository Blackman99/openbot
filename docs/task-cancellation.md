# Cancel a Task and retain interrupted output

Open the Task details and choose **Cancel task**. The original execution human can cancel while they retain access to the conversation. In a group, a current owner or administrator can also cancel another member's work. Workspace ownership alone does not grant access to a private conversation or group. Stopping uses current conversation inspection; it does not require an enabled provider, a remaining model-use grant or a new provider call. A revoked membership or role is checked again when the command runs.

Cancellation commits the selected Task and every unfinished descendant together. Completed and failed attempts remain unchanged, including terminal Tasks between the selected Task and an unfinished descendant. Other roots are unaffected. Queued cancellation prevents a provider call. For a running Task, the worker independently observes the durable cancellation and aborts the active HTTP request, including a request that has produced no bytes. Each active Run has one serial observation loop with a 1,000ms interval after a successful check; database connection and query timeouts remain bounded. This is a detection target under a responsive database, not an unconditional network timing guarantee.

Already committed output stays visible as **Interrupted output**. It is escaped text, attributed to the pinned Bot, and is not a completed answer or an editable human message. Unpublished buffered text is discarded. Reloading Task details reads the full saved prefix even after the conversation's stream history expires. The conversation view retains its bounded preview budget and links to Task details. Closing the browser or an SSE reader does not cancel work.

The conversation restores cancelled details independently of the live event reader, with one bounded request active at a time and one attempt per retained Run until a fresh authorized bootstrap. A temporarily unavailable detail leaves existing interrupted text intact, offers Task details, and does not prevent other live updates or reconnects from the applied cursor. A 401/403 from either private reader still stops the live view and clears private state.

If the response is uncertain, use **Confirm unchanged cancellation** with the unchanged form. A known conflict requires **Refresh task** before another command. Replaying a command cannot create another Task, prompt, Run, cancellation transition or final answer. Cancelled work cannot be manually retried; refunds, pause/resume and automatic crash recovery are separate features.

## Private session API

All paths below are relative to `/api/v1/workspaces/:workspaceId/conversations/:conversationId/tasks`. Responses use `Cache-Control: private, no-store`. The write requires the authenticated session cookie and exact configured Web Origin. These routes do not introduce public token-based cancellation.

| Operation                                 | Contract                                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /:taskId/cancellations`             | Exact JSON `{ "idempotencyKey": "stable-command", "expectedRunId": "uuid" }`. Keys contain 1–128 printable ASCII characters without spaces. Returns HTTP200 with `{task, receipt}` after the transaction commits. |
| Receipt                                   | `commandId`, selected `taskId`, `rootTaskId`, expected `runId`, `attempt`, `cancelledAt`, `affectedTaskCount`, `affectedRunCount`. Counts refer to newly changed current Runs/Tasks.                              |
| Exact replay                              | Current stop authority is rechecked. The same actor/Task/key and expected Run returns the original receipt, alongside the current Task view. Reusing the key with a different Run conflicts.                      |
| New key on the same cancelled Run         | Persists a zero-effect receipt with the original cancellation time. No new marker, audit, delivery transition or output is written.                                                                               |
| `GET /:taskId/runs/:runId/partial-output` | Exact cancelled Task/Run scope under current conversation inspection; no query parameters. Returns `{conversationId, taskId, runId, partial}`. `partial` is `null` or `{text, endByte, interrupted: true}`.       |

A stale expected Run or completed/failed selected Task returns409. Invalid/foreign scope or insufficient current authority returns403. A valid session survives a403; unauthenticated requests return401. Unknown write outcomes retain the same command key and expected Run. A partial read for a noncancelled Run returns409; this endpoint does not expose failed-attempt partials.

## Persistence and ordering

Actual migration `0023_task_tree_cancellation` follows `0022_failed_task_retries`. It adds immutable Task root/parent/depth, retained command receipts, one cancellation marker per changed Run, and one durable `task_run_partial_outputs` checkpoint per Run. Existing Tasks become roots. The child fixture used by native tests constructs a separate legal human trigger, exact grant/hash, first Run and receipt per child; it does not implement delegated Task creation.

Cancellation takes the existing workspace/group/direct-Bot/conversation inspection locks, then the tree root, ordered selected Tasks and their current Runs. Claim, delta, completion, retry and child admission preserve root/ancestor and latest-Run fences. All affected states, markers, audit events and typed delivery receipts commit together. Native guards retain queued NULL claim/provider fields, running claim identity, historical terminal states and immutable receipts. Runtime grants remain narrow and do not grant audit reads.

Each accepted delta and its cumulative UTF-8 checkpoint commit in the same transaction as stream progress, before retention and final deadline checks. A checkpoint is bounded to 32,000 JavaScript string units and 128,000 UTF-8 bytes, uses exact contiguous offsets, and never guesses a missing prefix. Stream retention cannot delete this checkpoint. Canonical successful completion deletes its superseded checkpoint in the same transaction; cancelled checkpoints are immutable and cannot be deleted by the runtime. Late callbacks, deltas, usage updates and final outputs recheck cancellation/current claim and cannot overwrite cancelled state or create a final answer.

## Upgrade from 0022

Before running0023, stop new claims and drain every old worker. Stop accepting new Task work during the deployment, shut down old worker instances through their normal signal handling, and verify that no retained Run is still `running`. Queued Runs remain durable for the upgraded workers. An unresolved running Run must be reconciled before proceeding; do not manufacture a missing output prefix or bypass the migration guard.

The migration locks Tasks/Runs and refuses atomically if any old Run remains running. It performs no partial DDL or ledger advance on refusal. Once drained, run the normal migration and runtime-grant provisioning with the new source, then restart API and all workers from that same source. No old worker may publish across this upgrade. Existing completed/failed history and queued prompts remain unchanged.

## Verification boundary

The local HTTP/browser witness uses production API/domain/worker/adapter code with pg-mem and a real loopback HTTP provider. It proves UI behavior and actual request abort, not PostgreSQL trigger/lock execution or separate-process deployment.

`postgres-task-cancellation` requires a dedicated PostgreSQL database and runs the native drain/upgrade, privilege, rollback and lock-order cases. `compose-task-cancellation` uses `infra/compose-task-cancellation.yaml` with a disposable HTTP provider: queued cancellation before worker configuration; separate worker claim while API is stopped; running and before-first-byte HTTP abort; a later independent completed Task; and retained private interrupted output after process restart and delivery reclamation. The existing general Compose and separate Task-worker jobs remain in place. Native and Compose execution are release gates; test discovery or skipped cases do not close them.
