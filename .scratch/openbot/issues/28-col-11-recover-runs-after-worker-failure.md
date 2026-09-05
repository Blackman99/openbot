---
sequence: 28
id: COL-11
title: "Recover Runs after worker failure"
status: blocked
blocked_by:
  - COL-05
  - COL-09
  - COL-07
  - COL-10
labels:
  - area:collaboration
  - area:worker
  - area:reliability
  - type:feature
  - mvp
---

# COL-11 — Recover Runs after worker failure

## Outcome

Leases, heartbeats, startup reconciliation, and guarded commits recover interrupted Runs without duplicate user-visible results.

## Blocked by

- [COL-05](22-col-05-stream-authorized-conversation-events-over-sse.md)
- [COL-09](26-col-09-retry-failed-tasks-with-immutable-attempts.md)
- [COL-07](24-col-07-cancel-task-trees-safely.md)
- [COL-10](27-col-10-add-bounded-retries-and-explicit-model-fallback.md)

## Acceptance criteria

- [ ] Restarting after a worker dies during a model call moves the Task to an explicit terminal or resumable state.
- [ ] A stale running Run is marked interrupted and recovery uses a new attempt.
- [ ] When two workers contend for an expired lease, only one can commit the result.
- [ ] Completed Tasks are not sent to a provider again after restart.
- [ ] Resumed SSE history records the interruption and recovery and contains one final assistant message.

## Non-goals

- High-availability database deployment
- Exactly-once provider execution
- Cross-region workers

## Discovered implementation dependencies

Recovery reuses COL-07 durable partial-output and cancellation fences, plus COL-10 persisted attempt chains, the shared continuation writer and the common automatic-run budget. It must not introduce a competing partial table or reset the shared budget. See [frontier handoff](../EXECUTION-FRONTIER-HANDOFF.md). These are implementation prerequisites for the approved criteria, not new criteria. All 67 tickets and 401 original acceptance texts remain unchanged.
