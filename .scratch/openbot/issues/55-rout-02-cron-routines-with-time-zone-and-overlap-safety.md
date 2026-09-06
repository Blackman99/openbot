---
sequence: 55
id: ROUT-02
title: "Cron routines with time-zone and overlap safety"
status: ready-for-agent
blocked_by:
  - ROUT-01
labels:
  - area:routines
  - area:scheduling
  - kind:feature
  - priority:mvp
---

# ROUT-02 — Cron routines with time-zone and overlap safety

## Outcome

One-time routines extend to five-field cron schedules that handle time zones, restarts, and overlap without duplicate work.

## Blocked by

- [ROUT-01](54-rout-01-execute-one-time-routines-end-to-end.md)

## Acceptance criteria

- [ ] The API and UI accept five-field cron expressions and IANA time zones and show the next execution and latest result.
- [ ] DST forward and backward integration tests trigger at the expected local time without duplicating an occurrence.
- [ ] If the prior task is still active, the next tick is recorded as skipped_overlap and creates no task.
- [ ] After restart, historical missed cron ticks are skipped and the schedule advances to its next future occurrence.
- [ ] A routine disables itself at expiration and creates no later tasks.
- [ ] Run history distinguishes completed, failed, cancelled, expired, and skipped_overlap outcomes.

## Non-goals

- Second-level cron
- Backfilling every missed execution
- User-configurable overlap policies
