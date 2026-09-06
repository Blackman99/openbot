---
sequence: 22
id: COL-05
title: "Stream authorized conversation events over SSE"
status: complete
blocked_by:
  - COL-03
  - COL-04
labels:
  - area:collaboration
  - area:streaming
  - type:feature
  - mvp
---

# COL-05 — Stream authorized conversation events over SSE

## Outcome

Authorized clients receive ordered model deltas and Task and Run state changes, with resumable delivery and no duplicate final messages.

## Blocked by

- [COL-03](20-col-03-store-conversations-in-an-immutable-event-ledger.md)
- [COL-04](21-col-04-execute-a-single-bot-task-end-to-end.md)

## Acceptance criteria

- [x] A slow test provider delivers at least one assistant delta before the Run completes.
- [x] Last-Event-ID resumes after the acknowledged event without gaps or duplicates.
- [x] Callers without conversation read access cannot open or resume its stream.
- [x] A completed stream converges to exactly one final ledger message.
- [x] Text deltas and Task and Run updates share one ordered, resumable cursor.

## Non-goals

- WebSocket delivery
- Native push notifications
- Permanent storage of superseded rendering deltas

## Accepted implementation and external evidence

Source `9425c6647869668bc6de9112349d69219cd40131` is integrated in reviewed source `0ff6898eee671f04987fd5024a0bbc3c2d0afef4`, tree `3173dfcb6ea9af4913c0eae5fea67748a623dce2`; the accepted evidence commit is `0fd1198e2c0dc1c43dc3e8f59742e4e58ab99f72`. Component and combined Spec/Standards reviews are CLEAN. The dedicated merger ran one complete `pnpm verify` with exit 0: 1,453 nonbrowser tests, 53 ordinary browser journeys, one OIDC journey, formatting, zero-error/zero-warning Web types and both production builds. See [combined evidence](../STREAM-BATCH-VERIFICATION.md).

`COL-05-E1` closed by [Verify33965537394](../VERIFY-33965537394.md), completed 2026-09-05 at 12:21:46 UTC with all 14 jobs successful. Its exact published/actual checkout tree is `89a71e230bac00504399752670ff7e19c1b58260`. Actual PostgreSQL and Compose witnesses are recorded in the linked evidence; local skips are excluded. The original acceptance texts are unchanged.
