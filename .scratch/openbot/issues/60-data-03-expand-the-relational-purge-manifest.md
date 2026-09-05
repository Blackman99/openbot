---
sequence: 60
id: DATA-03
title: "Expand the relational purge manifest"
status: blocked
blocked_by:
  - DATA-02
  - ROUT-02
  - NOTIF-02
  - COL-18
  - COL-19
labels:
  - area:data-lifecycle
  - kind:expand-contract
  - phase:expand
  - priority:mvp
---

# DATA-03 — Expand the relational purge manifest

## Outcome

The expand phase introduces a versioned purge manifest and retryable handlers for relational collaboration data without exposing final purge.

## Blocked by

- [DATA-02](59-data-02-workspace-soft-deletion-and-grace-period-recovery.md)
- [ROUT-02](55-rout-02-cron-routines-with-time-zone-and-overlap-safety.md)
- [NOTIF-02](57-notif-02-mention-notifications-and-per-group-muting.md)
- [COL-18](35-col-18-price-model-usage-and-enforce-cost-budgets.md)
- [COL-19](36-col-19-pause-tasks-for-human-input-and-approval.md)

## Acceptance criteria

- [ ] A dry-run manifest lists every target relational table, purge-handler version, and estimated row count.
- [ ] Bots, groups, messages, tasks and runs, routines, notifications, memory metadata, and API tokens each have a registered purge handler.
- [ ] Handlers reject workspaces that are still in their grace period or have been restored.
- [ ] Every handler is safely repeatable; a second execution neither fails nor expands the target scope.
- [ ] A failed purge resumes after the last completed handler and never reports partial completion as final success.
- [ ] Integration tests prove all relational data in a neighboring workspace remains unchanged.

## Non-goals

- Enabling irreversible purge
- Deleting object storage
- Clearing caches or indexes outside the database
