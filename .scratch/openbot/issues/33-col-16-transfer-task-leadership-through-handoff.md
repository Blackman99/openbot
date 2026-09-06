---
sequence: 33
id: COL-16
title: "Transfer Task leadership through handoff"
status: complete
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

- [x] Only a schema-valid handoff action can change the Task Lead.
- [x] The source, target, and reason are appended as a public conversation event.
- [x] After handoff, the prior Lead cannot commit the final answer.
- [x] The successor receives only context allowed by its history grant and effective budget.
- [x] Invalid targets are rejected without leaving the Task with split ownership.
- [x] A handoff or turn hard limit moves the Task to waiting_budget instead of starting another Run.

## Non-goals

- Parallel child creation
- Silent Lead replacement
- Handoff outside the group

## Implementation note

Only a schema-valid `handoff` model action with `grantId` and `reason` can change the Lead. Migration `0044_task_lead_handoffs` records one transfer per source Run. The current Run ends as `handed_off` without a final answer, a public `task.handoff` event names source, target, and reason, and exactly one successor Run starts for the new Lead. The successor assembles context from its own history grant. Invalid or same-Lead targets fail without a transfer. A handoff or turn hard cap holds `waiting_budget` instead of starting another Run. These notes do not change the original acceptance texts.

## Completion evidence

Closed on 2026-09-06 against product HEAD `3bf4f06` with Tester PASS on [Verify 34015588159](https://github.com/Blackman99/openbot/actions/runs/34015588159) at `32e9c93` (all 20 jobs green). The clock-only follow-up on `32e9c93` does not change handoff behavior.

1. `transfers the Lead only from a schema-valid action and ignores prose` completes on the original Lead with no `task_handoffs` row when the model emits `@mentions` or JSON-looking text. `parseHandoffAction` accepts only `{ type: 'action', name: 'handoff', arguments: { grantId, reason } }`.
2. `appends source, target, and reason then starts one successor Run` inserts one public `task.handoff` event naming Lead, Researcher, and the reason, then queues exactly one successor for the target grant.
3. The source Run ends as `failed` / `error_code='handed_off'` with no `bot.message.created`. The successor, not the prior Lead, commits the final answer.
4. The successor claim assembles messages under the new grant. The happy-path successor still sees the triggering user body and completes as the target Bot.
5. `rejects inactive, unauthorized, and self targets without split ownership` keeps the original Lead and writes no `task_handoffs` row when the action targets the current grant.
6. `holds waiting_budget on a handoff hard limit instead of starting another Run` with `maxHandoffs: 0` parks the Task, leaves the Lead unchanged, and keeps a single Run.
