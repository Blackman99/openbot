---
sequence: 34
id: COL-17
title: "Meter and enforce token budgets"
status: complete
blocked_by:
  - COL-12
  - COL-13
  - PROV-05
labels:
  - area:collaboration
  - area:budgets
  - area:usage
  - type:feature
  - mvp
---

# COL-17 — Meter and enforce token budgets

## Outcome

Input, output, and total token budgets are atomically reserved and reconciled across all scopes, with local estimates when endpoints omit usage.

## Blocked by

- [COL-12](29-col-12-enforce-hierarchical-execution-limits.md)
- [COL-13](30-col-13-enforce-atomic-run-concurrency-limits.md)
- [PROV-05](11-prov-05-manage-capabilities-overrides-and-compatible-fallback-chains.md)

## Acceptance criteria

- [x] Provider usage is stored as actual; local counts are stored with estimated set to true.
- [x] Each Run atomically reserves token allowance at every applicable scope before starting.
- [x] Concurrent Runs cannot exceed a hard token limit through a reservation race.
- [x] Finishing or aborting reconciles reserved tokens to actual or estimated usage.
- [x] A soft limit warns; a hard limit blocks the next Run and moves the Task to waiting_budget.
- [x] The UI shows used, reserved, and remaining tokens and distinguishes actual from estimated usage.

## Non-goals

- Provider invoice reconciliation
- Cost enforcement
- A required embedding API

## Implementation note

Provider counts persist as actual (`estimated=false`); omitted usage falls back to a local UTF-8/4 estimate. Migration `0041_task_token_usage` stores `usage_estimated` paired with token counts. Reservation math evaluates used+reserved+request against input, output, and total caps, warns at four fifths, and reconciles reserved tokens to recorded usage. Execution policy accepts per-scope input, output, and total token caps. Bot `maxTotalTokens` is a per-Run generation cap, not a Task-lifetime pool. Migration `0042_task_token_budgets` stores used plus reserved ledgers and one reservation per Run. Claim locks those ledgers, reserves the next allowance, and holds `waiting_budget` on a hard cap. Finish, fail, or cancel deletes the reservation with `RETURNING` so `openbot_runtime` never needs UPDATE on `task_token_reservations`. Task reads expose used, reserved, and remaining per applicable scope. Soft token crossings on workspace, group, and task pools emit `task.limit.warning`; the per-Run Bot cap does not warn.

## Completion evidence

Closed on 2026-09-06 against product HEAD `a6a1456` with Tester PASS on [Verify 34014775723](https://github.com/Blackman99/openbot/actions/runs/34014775723) at `2921166` (all 20 jobs green). Native `postgres-tasks`, `postgres-task-cancellation`, `postgres-conversation-streams`, and `postgres-memories` finished, failed, and cancelled under `openbot_runtime` without `42501` on token reservations. `compose-task-limits`, `compose-tasks`, `compose-task-concurrency`, `compose-task-pause`, `compose-task-cancellation`, and `compose-task-recovery` stayed green. Soft `task.limit.warning` remains covered by the token-budget enforcement suite. This does not implement COL-18 cost budgets.
