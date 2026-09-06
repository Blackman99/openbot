---
sequence: 33
id: COL-16
title: "Transfer Task leadership through handoff"
status: in-progress
blocked_by:
  - COL-12
  - COL-14
labels:
  - area:collaboration
  - area:handoff
  - area:tasks
  - type:feature
  - mvp
---

# COL-16 — Transfer Task leadership through handoff

## Outcome

A validated handoff atomically transfers the same Task to an eligible group Bot, ends the current Run, and starts one audited successor Run.

## Blocked by

- [COL-12](29-col-12-enforce-hierarchical-execution-limits.md)
- [COL-14](31-col-14-delegate-a-bounded-child-task.md)

## Acceptance criteria

- [ ] Only a schema-valid handoff action can change the Task Lead.
- [ ] The source, target, and reason are appended as a public conversation event.
- [ ] After handoff, the prior Lead cannot commit the final answer.
- [ ] The successor receives only context allowed by its history grant and effective budget.
- [ ] Invalid targets are rejected without leaving the Task with split ownership.
- [ ] A handoff or turn hard limit moves the Task to waiting_budget instead of starting another Run.

## Non-goals

- Parallel child creation
- Silent Lead replacement
- Handoff outside the group

## Implementation note

Only a schema-valid `handoff` model action with `grantId` and `reason` can change the Lead. Migration `0044_task_lead_handoffs` records one transfer per source Run. The current Run ends as `handed_off` without a final answer, a public `task.handoff` event names source, target, and reason, and exactly one successor Run starts for the new Lead. The successor assembles context from its own history grant. Invalid or same-Lead targets fail without a transfer. A handoff or turn hard cap holds `waiting_budget` instead of starting another Run. Original acceptance texts stay unchecked.
