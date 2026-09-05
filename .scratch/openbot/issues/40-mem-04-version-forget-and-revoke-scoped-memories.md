---
sequence: 40
id: MEM-04
title: "Version, forget, and revoke scoped memories"
status: complete
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

- [x] Editing a memory appends a new version and leaves the previous version immutable.
- [x] Forgetting a memory appends a tombstone and immediately removes its content from lists, search results, and new model contexts.
- [x] Deleting or tombstoning a source message marks every derived memory as pending revocation and immediately excludes it from retrieval.
- [x] An authorized user can explicitly retain a derived fact as an independent memory or confirm its revocation.
- [x] Rebuilding derived indexes does not restore tombstoned, superseded, or revoked memory versions.
- [x] After content purge, audit records retain identifiers and action metadata but no forgotten memory text.

## Non-goals

- Backup expiration policy
- Global retention scheduling
- Restoring forgotten content
- Editing source conversation events in place

## Discovered implementation dependencies

Migration `0031_memory_revisions_and_revocations` appends edit and tombstone revisions and revocation events. Source `memory_versions` rows stay version 1 and immutable. Lists, search, and new run context exclude tombstoned, pending, and revoked memories. Retain stores independent text without a source read path. Audit events record identifiers and actions only. These notes do not change the original acceptance texts.

## Completion evidence

Closed on 2026-09-05 against product HEAD `a7f4d31` with Verify [33989291158](https://github.com/Blackman99/openbot/actions/runs/33989291158) (all 16 jobs green), including `postgres-memories`.

1. Edit: `POST .../edits` appends `memory_revisions` version 2; `memory_versions` stays version 1.
2. Forget: a tombstone removes the memory from list, search, GET, and run-context predicates.
3. Source removal: conversation tombstone/purge enqueues pending revocation for group, private, and approved-fact derivatives and excludes them from retrieval.
4. Retain/revoke: an authorized member can keep independent text or confirm revocation; GET of a pending memory stays forbidden.
5. Rebuild: inserting a later edit after a tombstone does not restore the memory to lists.
6. Audits: `memory.edited`, `memory.forgotten`, `memory.retained`, and `memory.revoked` store identifiers and actions only, with no forgotten text.
