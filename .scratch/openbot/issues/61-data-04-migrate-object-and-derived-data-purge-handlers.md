---
sequence: 61
id: DATA-04
title: "Migrate object and derived-data purge handlers"
status: blocked
blocked_by:
  - DATA-03
  - DOC-01
  - IMG-01
labels:
  - area:data-lifecycle
  - kind:expand-contract
  - phase:migrate
  - priority:mvp
---

# DATA-04 — Migrate object and derived-data purge handlers

## Outcome

The migrate phase adds purge handlers for attachments, export archives, summaries, search indexes, caches, and encrypted connection material.

## Blocked by

- [DATA-03](60-data-03-expand-the-relational-purge-manifest.md)
- [DOC-01](44-doc-01-query-pdf-docx-and-xlsx-knowledge-with-precise-locators.md)
- [IMG-01](45-img-01-send-authorized-image-attachments-to-vision-capable-models.md)

## Acceptance criteria

- [ ] After purge, object storage contains no attachment or temporary export archive for the target workspace.
- [ ] The target workspace's summaries, full-text index, vector index, and cache are no longer addressable or searchable.
- [ ] Provider-connection ciphertext and associated key-wrapping material are deleted.
- [ ] The purge manifest records status and failure details for every non-relational data handler.
- [ ] Partial failures are safely retryable without damaging already-completed data or unrelated resources.
- [ ] Fault-injection tests prove no handler can delete another workspace's objects or indexes.

## Non-goals

- Enabling the retention scheduler
- Actively erasing unexpired backups
- Cross-instance object replication
