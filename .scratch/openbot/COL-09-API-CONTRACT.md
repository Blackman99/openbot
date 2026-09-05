# COL-09 failed-Task retry contract

Root approved this boundary against the five original COL-09 acceptance criteria.
The starting source is accepted COL-04 `cb9977374ff2b3d40ebb9b5783647d99c32cfcb1`.
Migration `0022_failed_task_retries` follows actual 0019 (streaming), 0020
(memory), and 0021 (routing). Tests use that ordered migration; no published
migration is rewritten and no predecessor placeholder is registered.

## Retry command

`POST /api/v1/workspaces/:workspaceId/conversations/:conversationId/tasks/:taskId/retries`
accepts exactly `{idempotencyKey, expectedRunId}`. The key follows existing
1–128 visible-ASCII command rules; the Run ID is a canonical UUID. The endpoint
requires the trusted Origin and current session, and returns private/no-store.

Only the Task's original execution human may retry, with current conversation,
exact retained group grant (when present), Bot use, pinned version, and model
rights. Neither group administration nor Bot ownership lends another human's
credentials. Admission uses the existing workspace → group → Bot → conversation
→ Task → Run → provider lock order. Recheck rights after lock waits, including
for idempotent replays.

A new command requires a failed Task whose current Run is `expectedRunId` and
failed. One transaction inserts a durable immutable retry command and the next
queued Run, advances the same Task to queued, and writes the mandatory safe
`task.retried` audit. No new Task or human trigger is created. The existing
COL-05 transaction-owned `appendQueuedRunState(connection, runId, now)` writer
publishes its queued state in that transaction; there is no second allocator.

Return 202 `{task, receipt:{runId,attempt}}`. The receipt always identifies the
attempt created by that retry command. Exact same-key/payload replay returns
that stable receipt and the current Task, even after later attempts. Changed
payload with that key returns 409 `idempotency_conflict`. Queued/running/completed
states return 409 `task_retry_state_conflict`; a stale expected Run returns
409 `task_retry_run_conflict`. Exhausting the database's representable attempt
integer returns fixed 409 `task_attempt_exhausted`, not raw SQL diagnostics.
Input/access/model/unavailable errors retain existing safe Task error codes.

The Task's execution human, Bot/version, exact grant, original trigger and all
older Runs stay unchanged. A newly admitted connection revision belongs only to
the new Run; the pinned connection/model identity does not change. Only a
committed queued claim starts provider I/O. Failed old claims cannot publish.
An initial routing receipt and its bounded Task summary are retained unchanged,
even after the group chooses a different default Lead.

## Bounded current state and complete history

TaskView keeps `runs` as exactly the current attempt, and adds required `runCount`
and `olderRunsCursor`. Attempt 1 has count 1 and a null older cursor. This is an
explicit current-state view, not an unbounded or silently truncated history.

`GET .../tasks/:taskId/runs?cursor&limit` returns
`{conversationId,taskId,runs,nextCursor}`. Default limit is 20 and maximum 50.
Runs are newest to oldest. Opaque bounded cursors bind the conversation, Task,
maximum observed attempt, and exclusive next-attempt boundary. The cursor from
TaskView starts before its current attempt. All older attempts remain reachable;
there is no product retry ceiling. Reads require current conversation inspection,
not current provider availability, an active old grant, or execution rights.

The UI shows the current attempt out of the total, the current answer link, and
an explicit history link whenever older attempts exist. History shows each
preserved attempt's provider/model, usage, failure, output and timestamps. Retry
forms retain the exact key and expected Run after uncertain outcomes and permit
only unchanged replay; conflicts require an intentional refresh. Only actual
401 clears session identity; 403 preserves it. No automatic retry, fallback,
new prompt editing, historical-state replay, or public /v1 endpoint is added.

The trigger's identity remains fixed. Existing queue context uses current
permitted revisions and tombstones within the original trigger horizon; retry
does not resurrect an edited/deleted body or include later-created messages.
The UI describes this behavior without promising a frozen historical prompt.

## Verification

Use test-first API/worker/Web slices, then real PostgreSQL guards, observed lock
waits, concurrency, final-audit rollback, persisted attempts and old-claim
fencing. Browser checks require the root's shared-port lease. Native/Compose
skips remain external gates. Both independent review axes and a dedicated merge
are required before acceptance.
