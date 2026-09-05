---
sequence: 59
id: DATA-02
title: "Workspace soft deletion and grace-period recovery"
status: blocked
blocked_by:
  - DATA-01
  - WS-03
labels:
  - area:data-lifecycle
  - area:workspace
  - kind:feature
  - priority:mvp
---

# DATA-02 — Workspace soft deletion and grace-period recovery

## Outcome

Workspace owners can soft-delete a workspace after confirmation and restore it during a configurable grace period.

## Blocked by

- [DATA-01](58-data-01-auditable-workspace-data-export.md)
- [WS-03](05-ws-03-manage-workspace-members-and-roles.md)

## Acceptance criteria

- [ ] The confirmation page offers data export first and displays the exact purge_after time.
- [ ] After confirmation, ordinary members immediately lose workspace access through the UI, REST API, and SSE.
- [ ] During the grace period, an instance administrator or the original owner can restore all visible workspace state.
- [ ] Content, attachments, memory, and indexes are not physically deleted before the grace period ends.
- [ ] Repeated and concurrent delete or restore requests are idempotent and cannot create contradictory state.
- [ ] Deletion and restoration emit content-free security audit records.

## Non-goals

- Immediate irreversible deletion
- Any member deleting an entire workspace
- Bypassing export authorization
