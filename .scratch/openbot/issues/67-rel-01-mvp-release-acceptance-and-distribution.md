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

## Closed external gate — PROV-01-E1

- [x] Execute `postgres-providers` with real migration and runtime privilege provisioning; prove encrypted persistence, owner isolation, stale-write rejection, audit-failure rollback, deletion, and forbidden runtime DDL/audit updates.
- [x] Keep `postgres-auth` and Compose green on the combined provider revision.

## Closed external gate — WS-02-E1

- [x] Execute the isolated-schema invitation PostgreSQL tests for concurrent consumption, revocation, duplicate-email signup and transaction rollback.
- [x] Execute the integrated Compose invitation creation, acceptance, replay, revocation, hash-only persistence and audit checks with the restricted runtime role; verify its exact column privileges.

Both gates closed under [Verify33941168646](https://github.com/Blackman99/openbot/actions/runs/33941168646) on published commit `98f15fc88cdc44bc6cd14ac5542a9aad3fb58166`, completed on 2026-09-05 at 03:13:55 UTC. All four jobs passed: code, postgres-auth (4 real tests), postgres-providers (1 real restricted-role test), and Compose. Integrated local revision `62b0ab6` passed 186 unit/integration tests, 7 browser scenarios, formatting, types and both production builds. This evidence closes these ticket gates; the final release criteria still require verification on the final integrated revision.

## Non-goals

- HA or multi-region certification
- Kubernetes distribution
- Native clients
- Features outside the MVP contract


## Closed external gate — PROV-03-E1

- [x] Run the combined `postgres-providers` job on the PROV-03 revision, including explicit
  Responses protocol round-trip through the real restricted runtime role and encrypted storage.
- [x] Keep `postgres-auth` and Compose green on that combined revision. Earlier PROV-01/WS-02
  evidence does not certify later provider protocol/transport changes.

Local evidence and independent reviews are recorded in [PROV-03 verification](../PROV-03-VERIFICATION.md).

PROV-03-E1 closed by [Verify33941574408](https://github.com/Blackman99/openbot/actions/runs/33941574408), all four jobs successful on remote `8f7e47f50a935cffc849e29c73b48a89d75ee449`, completed on 2026-09-05 at 03:22:16 UTC.

## Closed external gate — PROV-04-E1

- [x] Execute the combined provider PostgreSQL test with both Responses and Anthropic, including persisted Anthropic version metadata and restricted-role storage, ownership, stale revisions and audit rollback.
- [x] Keep authentication/invitation PostgreSQL and Compose green on the same integrated revision.

Local combined verification at `87632a1` passed 249 unit/integration tests and 8 browser scenarios. [Verify33942334386](https://github.com/Blackman99/openbot/actions/runs/33942334386) passed all four jobs on remote `6fb668702377ba18fd39c2c7439f4112887f77fa`, completed on 2026-09-05 at 03:39:21 UTC, closing PROV-04-E1.

## Open external gate — WS-03-E1

- [ ] Execute the real PostgreSQL membership concurrency and rollback tests, including simultaneous last-owner changes and actor rechecks.
- [ ] Execute the integrated Compose member provenance, role boundaries, last-owner rejection, removal with retained authentication, preserved history and audit checks using the deployed runtime role.
- [ ] Verify membership DELETE and role-only UPDATE privileges, and the ordered migration ledger through `0006_workspace_member_provenance`.

Integrated revision `faea29a` passed 284 unit/integration tests, 9 browser scenarios, formatting, types and builds. The new deployment smoke was independently reviewed and all 20 workflow shell steps passed syntax checks. Actual PostgreSQL/Compose execution remains required; this explicit exception unlocks local PROV-02, COL-01 and API-01 work.
