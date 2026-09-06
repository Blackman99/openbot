# COL-08 — Pause/resume implementation handoff

English contract for COL-08. Ticket ACs remain authoritative and unchecked until Tester stamps later.

## Authority

- Ticket: `issues/25-col-08-pause-and-resume-tasks-from-checkpoints.md`
- Blockers COL-07 and COL-10 are complete. COL-08 is in progress on `feat/openbot-collaboration-system`.
- Resume must consume the single COL-10 `writeNextAttempt` writer. Do not add a second attempt allocator.

## Original acceptance criteria (unchanged)

- Queued and running Tasks can be paused through the API and UI.
- A paused Task holds no execution slot and remains paused across restarts.
- Resume creates a new attempt without mutating the interrupted Run.
- Repeated pause or resume requests create no duplicate attempts.
- Partial output, checkpoint metadata, and transition history remain visible after resume.

## State semantics

`paused` is the durable Task status and the frozen current Run status. They stay homomorphic. Pause does not create a Run. Resume creates one new queued Run and must not UPDATE the interrupted Run.

| Current selected Task/Run | Command | Result |
| --- | --- | --- |
| queued / queued | authorized pause, expected Run matches | same Run → paused; `finishedAt` is the pause time; claim/provider/usage stay as they were |
| running / running | authorized pause, expected Run matches | same Run → paused; retain claim/token/deadline/provider/usage and submitted partial |
| paused / paused | same-key pause replay | original receipt; no extra Run or checkpoint |
| paused / paused | new-key pause | zero-effect receipt; counts 0; original `pausedAt` |
| paused / paused | authorized resume by the original execution human | new queued Run via `writeNextAttempt` with origin `manual_resume`; old Run unchanged |
| completed / failed / cancelled | new pause or resume | state conflict |

Checkpoint strategy is `restart_from_task_input_v1`: re-execute the original Task input on a new attempt. This is not provider-native continuation.

## First landed slice

Queued pause only, selected Task only:

- Migration `0033_task_pause_checkpoints` admits `paused` and stores pause commands, markers, and zero-byte checkpoints.
- `POST /api/v1/workspaces/:workspaceId/conversations/:conversationId/tasks/:taskId/pauses` with `{idempotencyKey, expectedRunId}`.
- A paused queued Run is not claimable. Reconstructing `TaskService` still reads `paused`.
- Same-key replay returns the original receipt. A new key after pause is a zero-effect receipt.

## Leftover before the original ACs can be stamped

- Tester stamp of Compose pause/resume evidence on a green Verify (`compose-task-pause`).

Landed: queued and running pause, subtree pause, resume HTTP API through `writeNextAttempt` origin `manual_resume`, UI pause/resume forms, interrupted-output history, native `protect_task` / `protect_task_run` overlays after 0033, native PostgreSQL coverage for running pause, service resume, and group subtree pause/resume, and the `compose-task-pause` seed/pause/reloaded job.

Do not check the five AC boxes until Tester stamps those leftovers.
