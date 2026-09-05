---
sequence: 17
id: BOT-06
title: 'Archive, restore, and soft-delete bots'
status: complete
blocked_by:
  - BOT-03
  - BOT-04
labels:
  - bot
  - lifecycle
  - deletion
  - vertical-slice
  - mvp
---

# BOT-06 — Archive, restore, and soft-delete bots

## Outcome

Bot owners can stop new work, restore archived bots, or place bots in an auditable soft-deleted state for the retention window.

## Blocked by

- [BOT-03](14-bot-03-edit-compare-and-restore-bot-versions.md)
- [BOT-04](15-bot-04-grant-bot-owner-editor-and-user-permissions.md)

## Acceptance criteria

- [x] An owner can archive a bot; configuration and historical references remain readable while all new-use requests are rejected.
- [x] An owner can restore an archived bot after revalidating that its model connection is enabled and accessible.
- [x] A soft-deleted bot is hidden from selectors and default lists, cannot start new work, and records deletion and grace-period timestamps.
- [x] Only an owner can undo deletion during the grace period; non-owner archive, restore, delete, or undo requests return HTTP 403.
- [x] Repeated archive, restore, and soft-delete requests are idempotent, and historical references retain the stable bot ID and deleted-identity marker.
- [x] API and UI tests cover every lifecycle transition and audit event and explicitly prove that this ticket does not claim physical erasure.

## Non-goals

- Physical erasure after retention expires
- Expiration of data in backups
- Rewriting authorship in existing history

## Implementation handoff

Follow [BOT-COPY-LIFECYCLE-HANDOFF](../BOT-COPY-LIFECYCLE-HANDOFF.md). BOT-03 is integrated; its remaining native evidence stays explicit in REL-01.

## Implementation and review evidence

All six criteria are implemented on `ticket/bot-06` from accepted COL-02 `28ce290`. Production source is `64944ed6bee07721ed6fe53f7221620dbb4ff8a1`; final source/test candidate is `839254997ef8dcb7f37c384e476b904191431f92`. Migration 0016 adds lifecycle fields independently of immutable versions, with precise runtime column grants. Owners have reachable archive/restore/delete/recovery controls, while direct/group historical identity and retained configuration/avatar references remain protected.

The original author reported 920 passing unit/integration tests (API 409, Web 511), formatting, API/Web types, and both production builds at the frozen production pin. Finishing verification passed the two lifecycle browsers, then 27 of 28 ordinary browsers; the sole inherited group refresh synchronization failure was corrected with the exact separately reviewed readiness assertion and all four group/lifecycle journeys then passed. The separate signed-OIDC journey also passed, and both browser ports were confirmed closed and released. Complete gate details are recorded in [BOT-06-VERIFICATION](../BOT-06-VERIFICATION.md). The dedicated merger owns the complete combined `pnpm verify` before acceptance.

Both independent Standards and Specification reviews are CLEAN at `08462e6`; root rechecked the only subsequent two-line browser readiness delta CLEAN. The Standards finding corrected precise expected grant arrays in older native suites without changing production privileges or weakening negative assertions.

**BOT-06-E1 remains open:** all 24 lifecycle native cases are authored but explicitly skipped locally without `TEST_BOT_DATABASE_URL`. Actual PostgreSQL and deployed Compose privilege/migration execution are required external evidence. See [native evidence](../BOT-06-NATIVE-EVIDENCE.md) and [API contract](../BOT-06-API-CONTRACT.md). This author handoff does not claim native execution, physical erasure, final merged verification, or external gate closure.

## Accepted integration and remaining service evidence

Final source8392549 and documentationf0e7731 were independently reviewed and merged asae567149. The dedicated combined pnpm verify on0d641dba passed969 unit/integration tests,32 ordinary browsers, one signed-OIDC journey, formatting, types and both builds. Reviewed CI-only follow-up4b4b553 aligns Compose migration0016 and exact lifecycle column expectations; scoped YAML/shell/schema/grant/format checks passed. Actual native24 and deployed Compose evidence remain explicit BOT-06-E1 in REL-01.

## Actual external gate closure

BOT-06-E1 is closed by [Verify33956965487](https://github.com/Blackman99/openbot/actions/runs/33956965487), completed 2026-09-05 at09:07:34 UTC with all nine jobs successful. Actual native and Compose execution is recorded in [the service evidence](../VERIFY-33956965487.md). The tested tree exactly matches the accepted published candidate. This supersedes earlier pending/native-skip notes.
