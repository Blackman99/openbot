---
sequence: 29
id: COL-12
title: "Enforce hierarchical execution limits"
status: complete
blocked_by:
  - COL-06
  - COL-08
labels:
  - area:collaboration
  - area:budgets
  - area:policy
  - type:feature
  - mvp
---

# COL-12 — Enforce hierarchical execution limits

## Outcome

Workspace, Group, Task, and Run policies enforce the strictest duration, turn, delegation-depth, and handoff limits until an authorized user grants more budget.

## Blocked by

- [COL-06](23-col-06-add-deterministic-group-turn-routing.md)
- [COL-08](25-col-08-pause-and-resume-tasks-from-checkpoints.md)

## Acceptance criteria

- [x] Workspace, Group, Task, and Run policies resolve to the strictest effective limit per dimension.
- [x] Each Task stores an immutable snapshot of its starting limits and their sources.
- [x] Crossing a soft threshold appends a visible warning event.
- [x] Reaching a hard limit starts no further Run and moves the Task to waiting_budget.
- [x] An authorized idempotent grant changes only the selected limit and resumes without rewriting usage.
- [x] A Run timeout aborts its provider stream and preserves partial output and audit evidence.

## Non-goals

- Token limits
- Pricing and cost limits
- Bot-controlled limit increases

## Completion evidence

Closed on 2026-09-06 against product HEAD `dacc663` with Tester PASS on [Verify 34008091724](https://github.com/Blackman99/openbot/actions/runs/34008091724) (all 19 jobs green). `postgres-tasks` granted one selected duration cap and resumed `waiting_budget` without rewriting the snapshot, and kept an ordinary deadline timeout on Task+Run `failed` with no `task.limit.warning`. `postgres-conversation-streams` aborted a late finish, preserved the ledger, advanced the delivery tail by one failed-run frame, and wrote `execution_timeout` without `waiting_budget`. `compose-task-limits` seed snapshotted `max_duration_ms=1000` from the Task layer while the worker was unconfigured, the timeout stage kept `execution_timeout` failed then hard-held through `writeNextAttempt`, and the grant stage resumed attempt 2 without rewriting the snapshot. Soft-threshold `task.limit.warning` remains covered by the execution-limit integration suite. No local PostgreSQL or Docker execution is claimed. This does not implement COL-13 concurrency slots.
