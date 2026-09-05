---
sequence: 57
id: NOTIF-02
title: "Mention notifications and per-group muting"
status: blocked
blocked_by:
  - NOTIF-01
  - COL-02
  - COL-03
labels:
  - area:notifications
  - area:collaboration
  - kind:feature
  - priority:mvp
---

# NOTIF-02 — Mention notifications and per-group muting

## Outcome

Users receive reliable human-mention notifications and can set each group to all, mentions_only, or muted.

## Blocked by

- [NOTIF-01](56-notif-01-persistent-task-notification-inbox.md)
- [COL-02](19-col-02-add-bot-membership-and-history-grants.md)
- [COL-03](20-col-03-store-conversations-in-an-immutable-event-ledger.md)

## Acceptance criteria

- [ ] Human mentions store stable member IDs in message metadata, so renaming a member does not change the recipient.
- [ ] all receives every supported group event, mentions_only receives direct mentions only, and muted creates no group notifications.
- [ ] A notification-level change in group settings applies to the next event.
- [ ] A user removed from a group receives no new notifications from it.
- [ ] Mentioning an unauthorized or removed member does not disclose group content.
- [ ] Bot mentions affect collaboration routing without creating human notifications.

## Non-goals

- Keyword subscriptions
- Email digests
- Operating-system do-not-disturb synchronization
