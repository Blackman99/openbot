# COL-12 — Hierarchical execution limits implementation handoff

English contract for COL-12. Ticket ACs stay unchecked until Tester stamps native and Compose evidence.

## Authority

- Ticket: `issues/29-col-12-enforce-hierarchical-execution-limits.md`
- Blockers COL-06 and COL-08 are complete. COL-12 is in progress on `feat/openbot-collaboration-system`.
- Do not claim original ACs from this note.

## Root-fixed measurement

- Duration: active-Run milliseconds after lock wait.
- Turns: successful new Runs.
- Depth: parent edges from the root Task.
- Handoffs: committed Lead transfers.
- Workspace and Group caps are per-root templates copied onto each Task, not shared daily quotas.

## Original acceptance criteria (unchanged)

- Workspace, Group, Task, and Run policies resolve to the strictest effective limit per dimension.
- Each Task stores an immutable snapshot of its starting limits and their sources.
- Crossing a soft threshold appends a visible warning event.
- Reaching a hard limit starts no further Run and moves the Task to waiting_budget.
- An authorized idempotent grant changes only the selected limit and resumes without rewriting usage.
- A Run timeout aborts its provider stream and preserves partial output and audit evidence.

## First landed slice

Policy resolution and the immutable starting snapshot only:

- `resolveExecutionLimits` takes optional Workspace/Group/Task/Run policies and keeps the minimum value per duration, turn, delegation-depth, and handoff dimension. Equal values keep the most specific layer (`run` > `task` > `group` > `workspace`).
- Migration `0036_task_execution_limit_snapshots` stores optional JSONB `execution_policy` templates on workspaces and groups, plus one `task_execution_limit_snapshots` row per Task.
- Task submit copies Bot limits onto the Task layer, resolves the four layers, and inserts that snapshot in the same transaction. Same-key replay does not write another row. Later template edits do not rewrite the stored snapshot.
- Runtime may SELECT/INSERT snapshots only. Workspace/Group `execution_policy` stays off the existing metadata UPDATE grants.
- Duration is snapshotted as milliseconds. Handoff is omitted until a layer sets it.

## Second landed slice

Soft-threshold warnings and the hard-limit gate:

- Soft threshold is four fifths of each snapshotted hard cap. Crossing it appends one `task.limit.warning` conversation event, delivery frame, and `task_execution_limit_warnings` row per dimension.
- Duration is measured as active-Run milliseconds after lock wait. Turns count completed Runs. Depth is the retained Task depth. Handoffs stay at zero until COL-16.
- Reaching a hard limit starts no further Run. `writeNextAttempt` and claim refuse the successor; the Task moves to `waiting_budget` while the current Run keeps its queued/failed/paused state.
- Migration `0037_task_execution_limit_enforcement` admits `waiting_budget` and the warning ledger/delivery shape. Runtime may SELECT/INSERT warning rows only.

## Third landed slice

Run timeout uses the remaining snapshotted duration as the claim deadline:

- `claimNext` persists `deadline_at` from remaining snapshot milliseconds after lock wait, not a later Bot-config rewrite.
- Crossing that deadline aborts the provider stream, keeps the committed partial prefix, writes `execution_timeout` audit, and holds `waiting_budget` so no further Run starts.

## Leftover before the original ACs can be stamped

- Authorized idempotent grant of one selected limit without rewriting usage.
- Native PostgreSQL and Compose evidence for the snapshot/guards, enforcement, and timeout slice.

Do not check the six AC boxes until Tester stamps those leftovers.
