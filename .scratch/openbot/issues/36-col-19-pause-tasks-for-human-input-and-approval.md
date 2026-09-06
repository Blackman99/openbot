---
sequence: 36
id: COL-19
title: "Pause Tasks for human input and approval"
status: in-progress
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

- [ ] A valid request_input moves the Task to waiting_input and renders its prompt and response schema.
- [ ] A valid request_approval moves the Task to waiting_approval and renders approve and reject controls with an action summary.
- [ ] No Bot Run starts while a Task waits for input or approval.
- [ ] Only authorized human group members can respond; Bots cannot satisfy their own requests.
- [ ] One human response idempotency key resumes the Task exactly once as a new immutable Run.
- [ ] The request and decision are appended to the conversation audit without exposing secrets.
- [ ] Waiting Tasks survive restarts and remain cancellable before a response.

## Non-goals

- Approval for external tools
- Third-party approval channels
- Bot self-approval or timeout approval

## Implementation note

Schema-valid `request_input` and `request_approval` model actions pause the current Run without a final answer. `request_input` carries a prompt and a bounded object response schema; `request_approval` carries an action summary. Only an authorized human group member can submit one idempotent decision; Bots cannot satisfy their own requests. The decision resumes exactly one new Run. Original acceptance texts stay unchecked.
