---
sequence: 37
id: MEM-01
title: "Save a group message as scoped memory and use it in the next answer"
status: ready-for-agent
blocked_by:
  - BOT-01
  - COL-02
  - COL-03
  - COL-04
labels:
  - feature
  - area:memory
  - mvp
---

# MEM-01 — Save a group message as scoped memory and use it in the next answer

## Outcome

An authorized member can turn a visible conversation message into a group-scoped memory, inspect its provenance, and have it included in a later Bot run without exposing it outside that group.

## Blocked by

- [BOT-01](12-bot-01-create-and-inspect-a-persistent-bot-identity.md)
- [COL-02](19-col-02-add-bot-membership-and-history-grants.md)
- [COL-03](20-col-03-store-conversations-in-an-immutable-event-ledger.md)
- [COL-04](21-col-04-execute-a-single-bot-task-end-to-end.md)

## Acceptance criteria

- [ ] A member with the required group permission can save a visible message as group memory from both the conversation UI and REST API.
- [ ] The stored memory records the source event ID, creator, creation time, confidence, scope, and initial version.
- [ ] A subsequent Bot run in the same group receives the saved memory in its authorized context.
- [ ] A Bot in another group or Workspace cannot list, search, or receive the memory in model context.
- [ ] A Bot whose history grant excludes the source message cannot read or use the derived memory.
- [ ] Unauthorized create and read requests return 403 and append a content-free security audit entry.

## Non-goals

- Automatic candidate extraction
- Cross-scope promotion
- Embedding-based retrieval
- Workspace-wide knowledge
