---
sequence: 62
id: DATA-05
title: "Enforce retention and final purge"
status: blocked
blocked_by:
  - DATA-04
labels:
  - area:data-lifecycle
  - kind:expand-contract
  - phase:contract
  - priority:mvp
---

# DATA-05 — Enforce retention and final purge

## Outcome

The contract phase enables configurable retention, scheduled final purge, and a minimal content-free audit residue.

## Blocked by

- [DATA-04](61-data-04-migrate-object-and-derived-data-purge-handlers.md)

## Acceptance criteria

- [ ] Administrators can configure an allowed workspace retention period, which sets purge_after on new deletion requests.
- [ ] A workspace never enters final purge before purge_after, after restoration, or with an incomplete purge manifest.
- [ ] Final purge covers relational data, content, attachments, memory, summaries, indexes, caches, and key material.
- [ ] After completion, the workspace cannot be accessed, exported, restored, or read through the API or SSE.
- [ ] Only an irreversible workspace fingerprint, timestamp, actor, result, and counts remain; names and content do not.
- [ ] An end-to-end test seeds every data class in two workspaces, then proves the target is empty and its neighbor intact.

## Non-goals

- Legal-hold workflow
- Immediate erasure of historical offline backups
- Per-message retention policies
