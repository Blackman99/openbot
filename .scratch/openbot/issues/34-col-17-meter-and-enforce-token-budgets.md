---
sequence: 34
id: COL-17
title: "Meter and enforce token budgets"
status: in-progress
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

- [ ] Provider usage is stored as actual; local counts are stored with estimated set to true.
- [ ] Each Run atomically reserves token allowance at every applicable scope before starting.
- [ ] Concurrent Runs cannot exceed a hard token limit through a reservation race.
- [ ] Finishing or aborting reconciles reserved tokens to actual or estimated usage.
- [ ] A soft limit warns; a hard limit blocks the next Run and moves the Task to waiting_budget.
- [ ] The UI shows used, reserved, and remaining tokens and distinguishes actual from estimated usage.

## Non-goals

- Provider invoice reconciliation
- Cost enforcement
- A required embedding API

## Implementation note

Provider counts persist as actual (`estimated=false`); omitted usage falls back to a local UTF-8/4 estimate. Migration `0041_task_token_usage` stores `usage_estimated` paired with token counts. The persist slice passed [Verify 34013070215](https://github.com/Blackman99/openbot/actions/runs/34013070215) at `041fd7c`. Reservation math evaluates used+reserved+request against input, output, and total caps, warns at four fifths, and reconciles reserved tokens to recorded usage. Execution policy now accepts per-scope input, output, and total token caps. Bot `maxTotalTokens` is a per-Run generation cap, not a Task-lifetime pool. Admission evaluates every applicable workspace, group, task, and run budget. Migration `0042_task_token_budgets` stores used plus reserved ledgers at those scopes and one reservation per Run. Claim now locks those ledgers, reserves the next allowance at every applicable scope, holds `waiting_budget` on a hard cap, and finish, fail, or cancel reconciles reserved tokens to recorded usage. Task reads expose used, reserved, and remaining per applicable scope; the UI distinguishes actual from estimated Run usage. Soft token crossings are evaluated at four fifths but are not yet delivered as `task.limit.warning`. Original acceptance texts stay unchecked.
