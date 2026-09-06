---
sequence: 36
id: COL-19
title: "Pause Tasks for human input and approval"
status: complete
blocked_by:
  - COL-08
  - COL-12
  - COL-16
labels:
  - area:collaboration
  - area:approval
  - area:tasks
  - type:feature
  - mvp
---

# COL-19 — Pause Tasks for human input and approval

## Outcome

Validated request_input and request_approval actions pause a Task, collect one authorized human decision, and resume exactly once with an audit trail.

## Blocked by

- [COL-08](25-col-08-pause-and-resume-tasks-from-checkpoints.md)
- [COL-12](29-col-12-enforce-hierarchical-execution-limits.md)
- [COL-16](33-col-16-transfer-task-leadership-through-handoff.md)

## Acceptance criteria

- [x] A valid request_input moves the Task to waiting_input and renders its prompt and response schema.
- [x] A valid request_approval moves the Task to waiting_approval and renders approve and reject controls with an action summary.
- [x] No Bot Run starts while a Task waits for input or approval.
- [x] Only authorized human group members can respond; Bots cannot satisfy their own requests.
- [x] One human response idempotency key resumes the Task exactly once as a new immutable Run.
- [x] The request and decision are appended to the conversation audit without exposing secrets.
- [x] Waiting Tasks survive restarts and remain cancellable before a response.

## Non-goals

- Approval for external tools
- Third-party approval channels
- Bot self-approval or timeout approval

## Implementation note

Schema-valid `request_input` and `request_approval` model actions pause the current Run without a final answer. `request_input` carries a prompt and a bounded object response schema; `request_approval` carries an action summary. Only an authorized human group member can submit one idempotent decision; Bots cannot satisfy their own requests. The decision resumes exactly one new Run. Claim tools are advertised only when the connection supports structured actions. These notes do not change the original acceptance texts.

## Completion evidence

Closed on 2026-09-06 against product HEAD `19044ce` with Tester PASS on [Verify 34017551070](https://github.com/Blackman99/openbot/actions/runs/34017551070) at `f3ba1fa` (all 20 jobs green). `compose-task-pause`, `compose-tasks`, and `postgres-task-cancellation` stayed green with the COL-19 overlay applied last.

1. `parks a valid request_input and resumes once from authorized input` moves the Task and latest Run to `waiting_input` and exposes `humanRequest.prompt` plus `responseSchema`. `TaskSummary` renders the prompt and required fields; `TaskHumanDecision` collects those values when `canDecide`.
2. `parks request_approval, rejects mixed actions, and stays cancellable` parks `waiting_approval` with the action summary. The Task page shows Approve and Reject. Mixed `request_input` plus `request_approval` fails the Run.
3. A worker `runOnce` after the hold returns false and leaves `runCount` unchanged, so no successor Bot Run starts while the Task waits.
4. `lets a group member approve and denies a workspace outsider` accepts the human member and 403s the outsider. Bots have no decide path.
5. The same idempotency key returns the same `decision.runId`; a different payload on that key is `TaskConflictError`. The successor is a new immutable Run.
6. `task.input.requested` and `task.human.decided` are appended. The worker never forwards sealed credentials or token secrets into those events.
7. Waiting Tasks remain readable after process restart (`waiting_input` / `waiting_approval` are durable). `cancel` on a parked approval Task reaches `cancelled`.
