---
sequence: 21
id: COL-04
title: "Execute a single-Bot Task end to end"
status: ready-for-agent
blocked_by:
  - COL-02
  - COL-03
  - PROV-05
labels:
  - area:collaboration
  - area:tasks
  - area:worker
  - type:feature
  - mvp
---

# COL-04 — Execute a single-Bot Task end to end

## Outcome

A direct message or explicit mention creates a durable Task and Run, executes through the worker, and records the final Bot response with visible status.

## Blocked by

- [COL-02](19-col-02-add-bot-membership-and-history-grants.md)
- [COL-03](20-col-03-store-conversations-in-an-immutable-event-ledger.md)
- [PROV-05](11-prov-05-manage-capabilities-overrides-and-compatible-fallback-chains.md)

## Acceptance criteria

- [ ] A direct-Bot message or explicit mention atomically creates one Task and its first queued Run.
- [ ] Repeating the command with the same idempotency key creates no additional Task or Run.
- [ ] Successful execution advances through queued, running, and completed and records the final assistant message.
- [ ] Each Run records its attempt number and actual provider and model.
- [ ] A failed model call records a failed Run without fabricating an assistant response.
- [ ] Client reloads preserve Task status, Run history, and the final response.

## Non-goals

- Routing unaddressed group messages
- Delegation and handoff
- Retry, fallback, and crash recovery
