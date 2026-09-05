---
sequence: 22
id: COL-05
title: "Stream authorized conversation events over SSE"
status: blocked
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

- [ ] A slow test provider delivers at least one assistant delta before the Run completes.
- [ ] Last-Event-ID resumes after the acknowledged event without gaps or duplicates.
- [ ] Callers without conversation read access cannot open or resume its stream.
- [ ] A completed stream converges to exactly one final ledger message.
- [ ] Text deltas and Task and Run updates share one ordered, resumable cursor.

## Non-goals

- WebSocket delivery
- Native push notifications
- Permanent storage of superseded rendering deltas
