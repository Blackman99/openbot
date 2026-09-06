---
sequence: 31
id: COL-14
title: "Delegate a bounded child Task"
status: ready-for-agent
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

- [ ] Only a schema-valid delegate action creates a child Task.
- [ ] The target must be an active, authorized Bot in the current group.
- [ ] The child records root, parent, and depth IDs and inherits stricter budgets, deadlines, and cancellation.
- [ ] After the child terminates, the parent creates exactly one Lead Run with the attributed result.
- [ ] Cancelling the parent cancels its unfinished child.
- [ ] Plain text, @mentions, and JSON-looking prose never create delegated Tasks.

## Non-goals

- Parallel fan-out
- Transferring final ownership
- Cross-group delegation
