---
sequence: 58
id: DATA-01
title: "Auditable workspace data export"
status: blocked
blocked_by:
  - API-01
  - BOT-04
  - COL-03
  - COL-18
  - ROUT-02
  - NOTIF-02
  - TPL-02
  - DOC-01
  - IMG-01
labels:
  - area:data-lifecycle
  - area:export
  - kind:feature
  - priority:mvp
---

# DATA-01 — Auditable workspace data export

## Outcome

Workspace administrators can generate and temporarily download a versioned, checksummed data archive without secrets.

## Blocked by

- [API-01](48-api-01-scoped-api-token-lifecycle.md)
- [BOT-04](15-bot-04-grant-bot-owner-editor-and-user-permissions.md)
- [COL-03](20-col-03-store-conversations-in-an-immutable-event-ledger.md)
- [COL-18](35-col-18-price-model-usage-and-enforce-cost-budgets.md)
- [ROUT-02](55-rout-02-cron-routines-with-time-zone-and-overlap-safety.md)
- [NOTIF-02](57-notif-02-mention-notifications-and-per-group-muting.md)
- [TPL-02](47-tpl-02-atomically-import-and-export-a-safe-bot-team-template.md)
- [DOC-01](44-doc-01-query-pdf-docx-and-xlsx-knowledge-with-precise-locators.md)
- [IMG-01](45-img-01-send-authorized-image-attachments-to-vision-capable-models.md)

## Acceptance criteria

- [ ] An export includes workspace configuration, members, bot configuration, group conversations, tasks and runs, routines, notifications, memory metadata, and attachments.
- [ ] The archive excludes password hashes, API tokens, provider secrets, key-wrapping material, and fields capable of recovering secrets.
- [ ] Only workspace administrators can create, inspect, or download that workspace's export.
- [ ] The archive contains its schema version, creation time, object manifest, and a checksum for every file.
- [ ] Export failures are observable and safely retryable, and repeated completion cannot produce conflicting state.
- [ ] Expired download archives are deleted automatically while content-free export metadata remains in the audit trail.

## Non-goals

- Direct cross-instance migration
- Continuous incremental backup
- Exporting plaintext secrets
