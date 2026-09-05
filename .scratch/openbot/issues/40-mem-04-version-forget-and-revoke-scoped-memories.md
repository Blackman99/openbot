---
sequence: 40
id: MEM-04
title: "Version, forget, and revoke scoped memories"
status: in-progress
blocked_by:
  - MEM-02
  - MEM-03
labels:
  - feature
  - area:memory
  - area:data-lifecycle
  - mvp
---

# MEM-04 — Version, forget, and revoke scoped memories

## Outcome

Users can correct or forget memories through an append-only revision history, and source removal invalidates derived memory and indexes without resurrecting stale content.

## Blocked by

- [MEM-02](38-mem-02-promote-group-memory-to-bot-private-memory-with-explicit-approval.md)
- [MEM-03](39-mem-03-extract-and-review-candidate-memories-from-completed-runs.md)

## Acceptance criteria

- [ ] Editing a memory appends a new version and leaves the previous version immutable.
- [ ] Forgetting a memory appends a tombstone and immediately removes its content from lists, search results, and new model contexts.
- [ ] Deleting or tombstoning a source message marks every derived memory as pending revocation and immediately excludes it from retrieval.
- [ ] An authorized user can explicitly retain a derived fact as an independent memory or confirm its revocation.
- [ ] Rebuilding derived indexes does not restore tombstoned, superseded, or revoked memory versions.
- [ ] After content purge, audit records retain identifiers and action metadata but no forgotten memory text.

## Non-goals

- Backup expiration policy
- Global retention scheduling
- Restoring forgotten content
- Editing source conversation events in place

## Discovered implementation dependencies

Migration `0031_memory_revisions_and_revocations` appends edit and tombstone revisions and revocation events. Source `memory_versions` rows stay version 1 and immutable. Lists, search, and new run context exclude tombstoned, pending, and revoked memories. Retain stores independent text without a source read path. Audit events record identifiers and actions only. These notes do not change the original acceptance texts, which stay unchecked.
