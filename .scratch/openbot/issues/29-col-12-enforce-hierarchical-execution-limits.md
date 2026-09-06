---
sequence: 29
id: COL-12
title: "Enforce hierarchical execution limits"
status: ready-for-agent
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

- [ ] Workspace, Group, Task, and Run policies resolve to the strictest effective limit per dimension.
- [ ] Each Task stores an immutable snapshot of its starting limits and their sources.
- [ ] Crossing a soft threshold appends a visible warning event.
- [ ] Reaching a hard limit starts no further Run and moves the Task to waiting_budget.
- [ ] An authorized idempotent grant changes only the selected limit and resumes without rewriting usage.
- [ ] A Run timeout aborts its provider stream and preserves partial output and audit evidence.

## Non-goals

- Token limits
- Pricing and cost limits
- Bot-controlled limit increases
