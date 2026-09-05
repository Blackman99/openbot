---
sequence: 67
id: REL-01
title: "MVP release acceptance and distribution"
status: blocked
blocked_by:
  - API-06
  - ROUT-02
  - NOTIF-02
  - DATA-05
  - DEPLOY-03
  - PWA-01
  - BOT-04
  - COL-19
  - TPL-02
  - DOC-01
  - IMG-01
labels:
  - area:release
  - kind:verification
  - priority:mvp
---

# REL-01 — MVP release acceptance and distribution

## Outcome

A clean-instance acceptance suite proves the complete multi-user, multi-model collaboration loop and produces a reproducible MVP release artifact.

## Blocked by

- [API-06](53-api-06-resumable-permission-scoped-sse-event-stream.md)
- [ROUT-02](55-rout-02-cron-routines-with-time-zone-and-overlap-safety.md)
- [NOTIF-02](57-notif-02-mention-notifications-and-per-group-muting.md)
- [DATA-05](62-data-05-enforce-retention-and-final-purge.md)
- [DEPLOY-03](65-deploy-03-consistent-backup-and-restore.md)
- [PWA-01](66-pwa-01-online-first-responsive-web-pwa.md)
- [BOT-04](15-bot-04-grant-bot-owner-editor-and-user-permissions.md)
- [COL-19](36-col-19-pause-tasks-for-human-input-and-approval.md)
- [TPL-02](47-tpl-02-atomically-import-and-export-a-safe-bot-team-template.md)
- [DOC-01](44-doc-01-query-pdf-docx-and-xlsx-knowledge-with-precise-locators.md)
- [IMG-01](45-img-01-send-authorized-image-attachments-to-vision-capable-models.md)

## Acceptance criteria

- [ ] The release guide initializes a clean Compose instance with healthy services, applied migrations, and a first administrator.
- [ ] Automated acceptance uses two users, two provider protocols, and three distinct bots to create a group, select a lead, delegate, hand off, and synthesize disagreement.
- [ ] Acceptance covers observation, pause, resume, cancellation, retry, approval, restart recovery, and budget exhaustion without state loss.
- [ ] History grants, membership permissions, cross-group memory, and workspace isolation all block unauthorized reads.
- [ ] Attachments promoted to knowledge, template import/export, routines, public API, SSE, and notifications each complete one end-to-end loop.
- [ ] Endpoint failure and repeated idempotent requests create no duplicate task and lose no confirmed state.
- [ ] Export followed by soft deletion and final purge removes all target content while preserving a neighboring workspace.

## Required external evidence

`FND-01-E1`, `AUTH-01-E1`, and `WS-01-E1` are closed by [Verify33938570768](https://github.com/Blackman99/openbot/actions/runs/33938570768) on published commit `ecc586a8d3b528728af2308e247c4c3c4fb75ffa`, completed successfully on2026-09-05 at02:17 UTC. The `code`, `postgres-auth`, and `compose` jobs all passed, including the real workspace isolation/failed-audit rollback and restricted runtime-role workspace smoke tests.

This evidence covers the first three tickets only. Each subsequently implemented ticket must retain any unexecuted external gate here, and the complete release acceptance criteria above must still pass against the final integrated revision.

## Non-goals

- HA or multi-region certification
- Kubernetes distribution
- Native clients
- Features outside the MVP contract
