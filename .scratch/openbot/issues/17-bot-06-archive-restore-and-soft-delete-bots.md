---
sequence: 17
id: BOT-06
title: "Archive, restore, and soft-delete bots"
status: blocked
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

- [ ] An owner can archive a bot; configuration and historical references remain readable while all new-use requests are rejected.
- [ ] An owner can restore an archived bot after revalidating that its model connection is enabled and accessible.
- [ ] A soft-deleted bot is hidden from selectors and default lists, cannot start new work, and records deletion and grace-period timestamps.
- [ ] Only an owner can undo deletion during the grace period; non-owner archive, restore, delete, or undo requests return HTTP 403.
- [ ] Repeated archive, restore, and soft-delete requests are idempotent, and historical references retain the stable bot ID and deleted-identity marker.
- [ ] API and UI tests cover every lifecycle transition and audit event and explicitly prove that this ticket does not claim physical erasure.

## Non-goals

- Physical erasure after retention expires
- Expiration of data in backups
- Rewriting authorship in existing history
