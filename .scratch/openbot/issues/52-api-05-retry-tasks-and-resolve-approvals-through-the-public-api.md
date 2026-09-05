---
sequence: 52
id: API-05
title: "Retry tasks and resolve approvals through the public API"
status: blocked
blocked_by:
  - API-04
  - COL-19
labels:
  - area:api
  - area:tasks
  - area:approvals
  - kind:feature
  - priority:mvp
---

# API-05 — Retry tasks and resolve approvals through the public API

## Outcome

External clients can retry failed tasks and retrieve, approve, or reject pending human approvals.

## Blocked by

- [API-04](51-api-04-submit-retrieve-and-cancel-tasks-idempotently.md)
- [COL-19](36-col-19-pause-tasks-for-human-input-and-approval.md)

## Acceptance criteria

- [ ] Retrying a failed task creates a new run under the original task while preserving the prior run, error, and audit history.
- [ ] Repeated retries with the same Idempotency-Key create only one new run.
- [ ] Only a token with tasks:approve owned by the assigned approver can approve or reject a request.
- [ ] Repeating the same decision on a closed approval returns the prior result; submitting the opposite decision returns 409.
- [ ] The web UI reflects API-driven retries and approval decisions without a page refresh.
- [ ] Every operation records the actor, timestamp, and task reference without recording token plaintext.

## Non-goals

- Approval-rule editor
- Multi-party voting approvals
- Delegated signatures from external identities
