---
sequence: 20
id: COL-03
title: "Store conversations in an immutable event ledger"
status: ready-for-agent
blocked_by:
  - COL-01
  - BOT-01
labels:
  - area:collaboration
  - area:conversations
  - area:data
  - type:feature
  - mvp
---

# COL-03 — Store conversations in an immutable event ledger

## Outcome

Group and direct-Bot conversations support idempotent writes, stable ordering, versioned edits, tombstones, cursor reads, and current-state projections.

## Blocked by

- [COL-01](18-col-01-add-group-lifecycle-and-human-membership.md)
- [BOT-01](12-bot-01-create-and-inspect-a-persistent-bot-identity.md)

## Acceptance criteria

- [ ] Repeated writes with the same idempotency key create one logical message.
- [ ] Concurrent writes receive unique, monotonically ordered conversation sequence numbers.
- [ ] Editing a message appends a version event without mutating the original event.
- [ ] Deleting a message appends a tombstone without deleting or mutating the original event.
- [ ] Default reads return the current projection; authorized audit reads return the full version chain.
- [ ] Cursor pagination preserves ordering and projections across service restarts.

## Non-goals

- Memory extraction and knowledge promotion
- Full-text and vector retrieval
- Real-time event delivery

## Implementation contract

Follow [CONVERSATION-LEDGER-CONTRACT](../CONVERSATION-LEDGER-CONTRACT.md) for direct-thread privacy, current permissions, idempotency/CAS, creation-horizon pagination with current projections, and the shared transaction-owned sequence allocator. COL-02 is an explicit downstream consumer; no temporary second ledger is needed.
