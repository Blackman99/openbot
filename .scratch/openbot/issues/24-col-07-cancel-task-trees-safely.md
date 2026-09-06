---
sequence: 24
id: COL-07
title: "Cancel Task trees safely"
status: complete
blocked_by:
  - COL-04
  - COL-05
labels:
  - area:collaboration
  - area:tasks
  - type:feature
  - mvp
---

# COL-07 — Cancel Task trees safely

## Outcome

Authorized users can idempotently cancel queued or running Tasks, abort active model calls, retain partial output, and reject late results.

## Blocked by

- [COL-04](21-col-04-execute-a-single-bot-task-end-to-end.md)
- [COL-05](22-col-05-stream-authorized-conversation-events-over-sse.md)

## Acceptance criteria

- [x] Cancelling a queued Task prevents any provider call for it.
- [x] Cancelling a running Task aborts the provider request and cancels every unfinished descendant.
- [x] Repeated cancellation leaves the Task tree in one consistent cancelled state.
- [x] Existing streamed output remains visible and marked interrupted.
- [x] Results arriving after cancellation cannot write or replace the final answer.

## Non-goals

- Provider refunds
- Pause and resume
- Automatic retry of cancelled work


## Implementation and verification

Accepted source merge `49d24d8b2ab81b2e2fe47fcf4f474ff66785c36b`, tree `2380e6e2148d109aec227958b69dc78849ca4369`, preserves the independently Spec/Standards CLEAN author source without application, infrastructure or workflow adaptations. Root independently reviewed the integration delta. See [dedicated integration evidence](../COL-07-INTEGRATION-VERIFICATION.md) and [author evidence](../COL-07-IMPLEMENTATION-EVIDENCE.md).

One literal `pnpm_config_verify_deps_before_run=false pnpm verify` exited 0: 1,504 nonbrowser tests (API 136 unit + 455 integration; Web 180 unit + 733 integration), 60 ordinary browser journeys and one signed OIDC journey, formatting, types and both builds. The seven cancellation browser journeys cover queued prevention, active and silent HTTP abort, retained escaped partial output, administrator authority, revocation, unknown committed-response confirmation and stale-Run refresh. Domain/worker tests cover unfinished descendant traversal and late claim/output fences. The immutable partial record survives feed reclamation; UTF-16 and UTF-8 limits have separate boundary regressions.

**COL-07-E1 is closed.** Tester PASS on [Verify 33993349287](https://github.com/Blackman99/openbot/actions/runs/33993349287), HEAD `b9a6747`: `postgres-task-cancellation` executed all 18 authored cases; `compose-task-cancellation` seed/cancel/reloaded stages passed on the separate API/worker/HTTP provider path. No local PostgreSQL or Docker execution is claimed. This closes the external gate and does not implement COL-08 pause/resume.
