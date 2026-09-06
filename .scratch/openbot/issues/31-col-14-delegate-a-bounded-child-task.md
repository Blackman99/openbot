---
sequence: 31
id: COL-14
title: "Delegate a bounded child Task"
status: complete
blocked_by:
  - COL-12
  - COL-13
  - PROV-05
labels:
  - area:collaboration
  - area:delegation
  - area:tasks
  - type:feature
  - mvp
---

# COL-14 — Delegate a bounded child Task

## Outcome

A Lead can invoke a validated delegate action that creates one bounded child Task for an eligible group Bot and resumes with its attributed result.

## Blocked by

- [COL-12](29-col-12-enforce-hierarchical-execution-limits.md)
- [COL-13](30-col-13-enforce-atomic-run-concurrency-limits.md)
- [PROV-05](11-prov-05-manage-capabilities-overrides-and-compatible-fallback-chains.md)

## Acceptance criteria

- [x] Only a schema-valid delegate action creates a child Task.
- [x] The target must be an active, authorized Bot in the current group.
- [x] The child records root, parent, and depth IDs and inherits stricter budgets, deadlines, and cancellation.
- [x] After the child terminates, the parent creates exactly one Lead Run with the attributed result.
- [x] Cancelling the parent cancels its unfinished child.
- [x] Plain text, @mentions, and JSON-looking prose never create delegated Tasks.

## Non-goals

- Parallel fan-out
- Transferring final ownership
- Cross-group delegation

## Implementation note

Only a schema-valid `delegate` model action with `grantId` and `body` creates a child. The worker parks the Lead as `waiting_child`, records root/parent/depth, and inherits a stricter snapshot. After the child terminates, exactly one `child_result` Lead Run resumes with the attributed result. Cancelling the waiting parent cancels the unfinished child. Prose, @mentions, and JSON-looking text never delegate. These notes do not change the original acceptance texts.

## Completion evidence

Closed on 2026-09-06 against product HEAD `eef3ba4` with Tester PASS on [Verify 34012044549](https://github.com/Blackman99/openbot/actions/runs/34012044549) (all 20 jobs green).

1. `creates one child only from a schema-valid action and ignores prose` creates no child from mention/JSON-looking text and one child from a valid action.
2. `rejects inactive, unauthorized, and cross-group targets without creating a child` fails the Lead as `provider_failed` and inserts no descendant.
3. The valid-action case records `root_task_id`, `parent_task_id`, `depth`, and a snapshot no looser than the parent.
4. `resumes the Lead with exactly one attributed Run after the child terminates` queues one `child_result` Run and injects the attributed child body.
5. `cancels an unfinished child when the waiting parent is cancelled` cancels both the parked Lead and the queued child.
