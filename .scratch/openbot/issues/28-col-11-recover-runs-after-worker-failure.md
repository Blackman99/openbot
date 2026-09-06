---
sequence: 28
id: COL-11
title: "Recover Runs after worker failure"
status: complete
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

- [x] Restarting after a worker dies during a model call moves the Task to an explicit terminal or resumable state.
- [x] A stale running Run is marked interrupted and recovery uses a new attempt.
- [x] When two workers contend for an expired lease, only one can commit the result.
- [x] Completed Tasks are not sent to a provider again after restart.
- [x] Resumed SSE history records the interruption and recovery and contains one final assistant message.

## Non-goals

- High-availability database deployment
- Exactly-once provider execution
- Cross-region workers

## Discovered implementation dependencies

Recovery reuses COL-07 durable partial-output and cancellation fences, plus COL-10 persisted attempt chains, the shared continuation writer and the common automatic-run budget. It must not introduce a competing partial table or reset the shared budget. See [frontier handoff](../EXECUTION-FRONTIER-HANDOFF.md). These are implementation prerequisites for the approved criteria, not new criteria. All 67 tickets and 401 original acceptance texts remain unchanged.

## Implementation note

Recovery consumes the single COL-10 `writeNextAttempt` writer with origin `worker_recovery`. Migration 0035 adds `task_run_leases`, `task_run_recovery_receipts`, and the `worker_interrupted` failure code. A 15 s claim lease and 1 s heartbeat fence late success after expiry. `execution_timeout` remains allowed when the hard deadline has elapsed. Runtime grants keep `worker_recovery` in the automatic-continuation helper.

## Completion evidence

Closed on 2026-09-06 against product HEAD `9a1385a` with Tester PASS on [Verify 34004247688](https://github.com/Blackman99/openbot/actions/runs/34004247688) (all 18 jobs green). `postgres-tasks` recovered an expired native claim once, raced two workers for one successor/claim/final output, and still failed a deadline-elapsed claim as `execution_timeout`. `postgres-conversation-streams` mapped an elapsed deadline through an expired lease. `compose-task-recovery` seed/killed/recovered stages passed: SIGKILL during a held model call, lease expiry, one `worker_interrupted` attempt, one completed successor, one recovery receipt, and no replay of the already-completed follow-up Task. Public tests cover lease fencing, two-recovery contention, completed-Task no-replay, and resumed SSE history with one final assistant message. No local PostgreSQL or Docker execution is claimed. This does not implement COL-12 hierarchical limits.
