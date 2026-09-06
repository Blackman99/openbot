---
sequence: 51
id: API-04
title: "Submit, retrieve, and cancel tasks idempotently"
status: in-progress
blocked_by:
  - API-01
  - COL-18
labels:
  - area:api
  - area:tasks
  - kind:feature
  - priority:mvp
---

# API-04 — Submit, retrieve, and cancel tasks idempotently

## Outcome

External clients can submit collaboration tasks idempotently, inspect their status and results, and cancel active work.

## Blocked by

- [API-01](48-api-01-scoped-api-token-lifecycle.md)
- [COL-18](35-col-18-price-model-usage-and-enforce-cost-budgets.md)

## Acceptance criteria

- [ ] POST /v1/tasks accepts a group, prompt, optional lead, and Idempotency-Key and creates one durable task.
- [ ] Repeating the same principal, route, body, and Idempotency-Key returns the same task without creating another run.
- [ ] Reusing an idempotency key with a different body returns 409 and leaves the original task unchanged.
- [ ] An authorized token can retrieve task status, delegation tree, budget consumption, and confirmed results.
- [ ] Cancellation terminates an unfinished task and repeated cancellation remains idempotent.
- [ ] A token without group access or tasks:write cannot submit or cancel a task.

## Non-goals

- Anonymous task submission
- Cross-workspace batch tasks
- Webhook callbacks
