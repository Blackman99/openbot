---
sequence: 21
id: COL-04
title: "Execute a single-Bot Task end to end"
status: complete-with-external-verification
blocked_by:
  - COL-02
  - COL-03
  - PROV-05
labels:
  - area:collaboration
  - area:tasks
  - area:worker
  - type:feature
  - mvp
---

# COL-04 — Execute a single-Bot Task end to end

## Outcome

A direct message or explicit mention creates a durable Task and Run, executes through the worker, and records the final Bot response with visible status.

## Blocked by

- [COL-02](19-col-02-add-bot-membership-and-history-grants.md)
- [COL-03](20-col-03-store-conversations-in-an-immutable-event-ledger.md)
- [PROV-05](11-prov-05-manage-capabilities-overrides-and-compatible-fallback-chains.md)

## Acceptance criteria

- [x] A direct-Bot message or explicit mention atomically creates one Task and its first queued Run.
- [x] Repeating the command with the same idempotency key creates no additional Task or Run.
- [x] Successful execution advances through queued, running, and completed and records the final assistant message.
- [x] Each Run records its attempt number and actual provider and model.
- [x] A failed model call records a failed Run without fabricating an assistant response.
- [x] Client reloads preserve Task status, Run history, and the final response.

## Non-goals

- Routing unaddressed group messages
- Delegation and handoff
- Retry, fallback, and crash recovery

## Accepted implementation and external gate

Source1f68e42933df9b143e0f1e0e3e66a11eea020c49 passed independent Standards and Spec reviews; final3505791 adds only evidence and contract documentation. Dedicated merge4627c6928805e261bbdbce2d8c64c59156b8cc15 has tree030bc87945970cc5fa19c392b3dd24b992e6dfa8. The four additive shared integration paths were independently reviewed CLEAN, preserving accepted copy/lifecycle features and all earlier gate records.

The complete merged pnpm verify exited0 on2026-09-05 at09:27:22 UTC:1039 unit/integration tests (API92+347, Web65+535),35 ordinary browser journeys and one signed OIDC journey, formatting, zero-error/zero-warning types and both final production builds. The observed final-response pagination defect was fixed test-first and independently rechecked with a real service/worker sequence32 response; browser reload also passes with30 earlier messages.

COL-04-E1 remains explicit in REL-01: all26 actual restricted-role PostgreSQL cases and separate-worker Compose execution must pass in CI, alongside fresh/upgrade through0017. Local discovery or skips do not close this gate. See [Web/review evidence](../COL-04-WEB-EVIDENCE.md), [core evidence](../COL-04-CORE-VERIFICATION.md), [native evidence](../COL-04-NATIVE-VERIFICATION.md) and [API contract](../COL-04-API-CONTRACT.md).
