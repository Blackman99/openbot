---
sequence: 65
id: DEPLOY-03
title: "Consistent backup and restore"
status: blocked
blocked_by:
  - DEPLOY-02
  - DATA-01
  - ROUT-02
  - NOTIF-02
  - DOC-01
  - IMG-01
labels:
  - area:deployment
  - area:backup
  - kind:feature
  - priority:mvp
---

# DEPLOY-03 — Consistent backup and restore

## Outcome

Compose administrators can create a versioned, checksummed consistent backup and restore it only into an empty target.

## Blocked by

- [DEPLOY-02](64-deploy-02-safe-upgrades-and-schema-compatibility-gate.md)
- [DATA-01](58-data-01-auditable-workspace-data-export.md)
- [ROUT-02](55-rout-02-cron-routines-with-time-zone-and-overlap-safety.md)
- [NOTIF-02](57-notif-02-mention-notifications-and-per-group-muting.md)
- [DOC-01](44-doc-01-query-pdf-docx-and-xlsx-knowledge-with-precise-locators.md)
- [IMG-01](45-img-01-send-authorized-image-attachments-to-vision-capable-models.md)

## Acceptance criteria

- [ ] Backup pauses new job acquisition and captures PostgreSQL and durable files at one consistent boundary.
- [ ] The archive includes application version, schema version, object manifest, and checksums but not the environment-supplied master key.
- [ ] Restore refuses a non-empty database or destination file volume.
- [ ] Changing any archived file makes checksum validation abort before writes begin.
- [ ] A restore into a clean Compose instance passes consistency tests for users, bots, groups, tasks, routines, notifications, and attachments.
- [ ] An incompatible application version produces an explicit error and leaves no partially restored instance.

## Non-goals

- Point-in-time recovery
- Cross-cloud backup replication
- Backing up the environment master key
