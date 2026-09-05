---
sequence: 35
id: COL-18
title: "Price model usage and enforce cost budgets"
status: blocked
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

- [ ] Only Workspace Admins can create or supersede model price versions.
- [ ] Models without prices display as unpriced and do not activate cost limits.
- [ ] A priced Run uses its actual or estimated tokens and the price version active at start.
- [ ] Retries and fallbacks charge the provider and model actually called.
- [ ] Atomic cost reservations prevent concurrent Runs from crossing an active hard limit.
- [ ] A hard cost limit moves the Task to waiting_budget until an authorized grant resumes it.

## Non-goals

- Provider invoice import
- Foreign-exchange conversion
- Automatic cheapest-model selection
