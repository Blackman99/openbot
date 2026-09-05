---
sequence: 54
id: ROUT-01
title: "Execute one-time routines end to end"
status: blocked
blocked_by:
  - API-01
  - COL-18
  - COL-19
labels:
  - area:routines
  - area:worker
  - kind:feature
  - priority:mvp
---

# ROUT-01 — Execute one-time routines end to end

## Outcome

Authorized users can create bounded one-time collaboration routines through the UI or API.

## Blocked by

- [API-01](48-api-01-scoped-api-token-lifecycle.md)
- [COL-18](35-col-18-price-model-usage-and-enforce-cost-budgets.md)
- [COL-19](36-col-19-pause-tasks-for-human-input-and-approval.md)

## Acceptance criteria

- [ ] A routine stores its owner, group, prompt, lead or routing policy, IANA time zone, execution time, budget, and expiration.
- [ ] Authorized users can create, edit, pause, resume, and cancel routines through the UI and /v1/routines.
- [ ] At its scheduled time, a routine creates exactly one standard collaboration task linked from the routine page.
- [ ] If the service restarts at trigger time, one unexpired routine execution is recovered without duplication.
- [ ] A database uniqueness constraint prevents concurrent workers from creating duplicate tasks for one occurrence.
- [ ] Bot collaboration actions cannot create routines or increase an existing routine's frequency or budget.

## Non-goals

- Bot-created schedules
- External event triggers
- Unlimited or non-expiring routines
