---
sequence: 30
id: COL-13
title: "Enforce atomic Run concurrency limits"
status: ready-for-agent
blocked_by:
  - COL-11
  - COL-12
labels:
  - area:collaboration
  - area:scheduling
  - area:worker
  - type:feature
  - mvp
---

# COL-13 — Enforce atomic Run concurrency limits

## Outcome

Workers safely enforce Workspace, Group, and Task concurrency limits, including four simultaneous Bot Runs per group by default, and explain queued work.

## Blocked by

- [COL-11](28-col-11-recover-runs-after-worker-failure.md)
- [COL-12](29-col-12-enforce-hierarchical-execution-limits.md)

## Acceptance criteria

- [ ] Concurrent workers never exceed four running Runs for a default group.
- [ ] An excess Run remains queued and reports the policy level blocking it.
- [ ] A completed, failed, paused, or cancelled Run releases its slot.
- [ ] Task child-concurrency limits apply independently of Workspace and Group limits.
- [ ] Expired worker leases release their slots and cannot permanently block the queue.

## Non-goals

- Scheduling without PostgreSQL
- Priority tiers
- Unbounded fan-out
