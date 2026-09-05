---
sequence: 24
id: COL-07
title: "Cancel Task trees safely"
status: blocked
blocked_by:
  - COL-04
  - COL-05
labels:
  - area:collaboration
  - area:tasks
  - type:feature
  - mvp
---

# COL-07 — Cancel Task trees safely

## Outcome

Authorized users can idempotently cancel queued or running Tasks, abort active model calls, retain partial output, and reject late results.

## Blocked by

- [COL-04](21-col-04-execute-a-single-bot-task-end-to-end.md)
- [COL-05](22-col-05-stream-authorized-conversation-events-over-sse.md)

## Acceptance criteria

- [ ] Cancelling a queued Task prevents any provider call for it.
- [ ] Cancelling a running Task aborts the provider request and cancels every unfinished descendant.
- [ ] Repeated cancellation leaves the Task tree in one consistent cancelled state.
- [ ] Existing streamed output remains visible and marked interrupted.
- [ ] Results arriving after cancellation cannot write or replace the final answer.

## Non-goals

- Provider refunds
- Pause and resume
- Automatic retry of cancelled work
