---
sequence: 26
id: COL-09
title: "Retry failed Tasks with immutable attempts"
status: complete-with-external-verification
blocked_by:
  - COL-04
labels:
  - area:collaboration
  - area:runs
  - type:feature
  - mvp
---

# COL-09 — Retry failed Tasks with immutable attempts

## Outcome

Authorized users can retry failed Tasks while preserving failed Runs and preventing duplicate attempts.

## Blocked by

- [COL-04](21-col-04-execute-a-single-bot-task-end-to-end.md)

## Acceptance criteria

- [x] Retrying a failed Task creates one queued Run with the next attempt number.
- [x] Repeated retry commands with one idempotency key create no additional Run.
- [x] Completed and running Tasks reject retry with a machine-readable state error.
- [x] The original failure, provider, model, output, and timestamps remain immutable and auditable.
- [x] A successful retry creates one current answer projection while preserving earlier attempts.

## Non-goals

- Automatic transient retries
- Automatic model fallback
- Arbitrary historical-state replay

## Accepted implementation and external evidence

Source `4c025e593cb2db80c767abe74896bac7344bd1c7` is integrated in reviewed source `0ff6898eee671f04987fd5024a0bbc3c2d0afef4`, tree `3173dfcb6ea9af4913c0eae5fea67748a623dce2`; the accepted evidence commit is `0fd1198e2c0dc1c43dc3e8f59742e4e58ab99f72`. Component and combined Spec/Standards reviews are CLEAN. The dedicated merger ran one complete `pnpm verify` with exit 0: 1,453 nonbrowser tests, 53 ordinary browser journeys, one OIDC journey, formatting, zero-error/zero-warning Web types and both production builds. See [combined evidence](../STREAM-BATCH-VERIFICATION.md).

`COL-09-E1` remains an explicit [REL-01 release gate](67-rel-01-mvp-release-acceptance-and-distribution.md): execute seven retry PostgreSQL cases within the actual Task suite and deployed migration 0022/immutable command privileges. Local skips and syntax checks do not satisfy native PostgreSQL or Compose evidence. The original acceptance texts are unchanged.
