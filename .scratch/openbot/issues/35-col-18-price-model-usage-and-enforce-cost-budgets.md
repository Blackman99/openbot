---
sequence: 35
id: COL-18
title: "Price model usage and enforce cost budgets"
status: complete
blocked_by:
  - COL-10
  - COL-17
labels:
  - area:collaboration
  - area:budgets
  - area:billing
  - type:feature
  - mvp
---

# COL-18 — Price model usage and enforce cost budgets

## Outcome

Administrators can version model prices and enforce atomic cost budgets across all scopes while treating unpriced models as unknown cost.

## Blocked by

- [COL-10](27-col-10-add-bounded-retries-and-explicit-model-fallback.md)
- [COL-17](34-col-17-meter-and-enforce-token-budgets.md)

## Acceptance criteria

- [x] Only Workspace Admins can create or supersede model price versions.
- [x] Models without prices display as unpriced and do not activate cost limits.
- [x] A priced Run uses its actual or estimated tokens and the price version active at start.
- [x] Retries and fallbacks charge the provider and model actually called.
- [x] Atomic cost reservations prevent concurrent Runs from crossing an active hard limit.
- [x] A hard cost limit moves the Task to waiting_budget until an authorized grant resumes it.

## Non-goals

- Provider invoice import
- Foreign-exchange conversion
- Automatic cheapest-model selection

## Implementation note

Only Workspace Owners and Administrators can create or supersede model price versions. Migration `0045_model_price_versions` stores immutable versions keyed by workspace, connection, and model; `0046_task_cost_budgets` stores used plus reserved micros at workspace, group, and task scopes with one reservation per Run. Unpriced models display as Unpriced and skip cost reservation even when a cost cap exists. A priced Run pins the active version at claim, charges actual or estimated tokens against that version, and fallbacks look up the model actually called. Claim locks cost ledgers, and finish, fail, or cancel deletes the reservation with `RETURNING`. A hard cost cap holds `waiting_budget` until an authorized `dimension=cost` grant raises the effective cap and resumes the queued Run. Migration `0048_task_cost_grants` admits that grant dimension. These notes do not change the original acceptance texts.

## Completion evidence

Closed on 2026-09-06 against product HEAD `ae7f6dd` plus authorized cost-grant resume `409aad6`, with Tester PASS on [Verify 34017551070](https://github.com/Blackman99/openbot/actions/runs/34017551070) at `f3ba1fa` (all 20 jobs green). Native `postgres-tasks`, `postgres-task-cancellation`, and the Compose task/limit jobs finished under `openbot_runtime` without rewriting pinned prices.

1. `lets only workspace admins create and supersede a price version` returns 403 for a member `PUT /api/v1/workspaces/:id/model-prices` and writes no `model_price_versions` row; the owner supersede leaves exactly one active version.
2. `leaves unpriced models outside cost limits and charges the pinned start-of-run version` shows `price.kind='unpriced'` and skips reservation when no version exists, even with `maxCostMicros: 1`.
3. A priced claim pins `price_version_id` on `queued → running` and charges actual or estimated tokens against that version. Task reads expose used/reserved/remaining micros; terminal Runs are not UPDATEd from reconcile.
4. `charges the fallback model that was actually called and holds waiting_budget on a hard cap` looks up the called connection/model, not the primary binding.
5. `locks cost ledgers so a second Run cannot reserve past the hard cap` serializes two claims against a 100-micros workspace cap (60 then 50).
6. A workspace `maxCostMicros: 1` hold parks `waiting_budget`. An authorized `dimension=cost` grant raises the effective cap and resumes one queued Run; a member grant is 403.
