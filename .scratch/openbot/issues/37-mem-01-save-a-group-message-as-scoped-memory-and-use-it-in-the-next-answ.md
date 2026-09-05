---
sequence: 37
id: MEM-01
title: "Save a group message as scoped memory and use it in the next answer"
status: complete-with-external-verification
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

- [x] A member with the required group permission can save a visible message as group memory from both the conversation UI and REST API.
- [x] The stored memory records the source event ID, creator, creation time, confidence, scope, and initial version.
- [x] A subsequent Bot run in the same group receives the saved memory in its authorized context.
- [x] A Bot in another group or Workspace cannot list, search, or receive the memory in model context.
- [x] A Bot whose history grant excludes the source message cannot read or use the derived memory.
- [x] Unauthorized create and read requests return 403 and append a content-free security audit entry.

## Non-goals

- Automatic candidate extraction
- Cross-scope promotion
- Embedding-based retrieval
- Workspace-wide knowledge

## Accepted implementation and external evidence

Source `19568c9fc603b97213cd5560a097471ba93107fa` is integrated in reviewed source `0ff6898eee671f04987fd5024a0bbc3c2d0afef4`, tree `3173dfcb6ea9af4913c0eae5fea67748a623dce2`; the accepted evidence commit is `0fd1198e2c0dc1c43dc3e8f59742e4e58ab99f72`. Component and combined Spec/Standards reviews are CLEAN. The dedicated merger ran one complete `pnpm verify` with exit 0: 1,453 nonbrowser tests, 53 ordinary browser journeys, one OIDC journey, formatting, zero-error/zero-warning Web types and both production builds. See [combined evidence](../STREAM-BATCH-VERIFICATION.md).

`MEM-01-E1` remains an explicit [REL-01 release gate](67-rel-01-mvp-release-acceptance-and-distribution.md): execute 14 dedicated memory PostgreSQL cases and the real scoped-source-memory Compose flow. Local skips and syntax checks do not satisfy native PostgreSQL or Compose evidence. The original acceptance texts are unchanged.
