---
sequence: 66
id: PWA-01
title: "Online-first responsive web/PWA"
status: blocked
blocked_by:
  - NOTIF-02
  - COL-03
  - COL-19
labels:
  - area:pwa
  - area:frontend
  - kind:feature
  - priority:mvp
---

# PWA-01 — Online-first responsive web/PWA

## Outcome

Openbot is installable as a PWA, supports full desktop administration, and enables mobile chat, approval, and task monitoring.

## Blocked by

- [NOTIF-02](57-notif-02-mention-notifications-and-per-group-muting.md)
- [COL-03](20-col-03-store-conversations-in-an-immutable-event-ledger.md)
- [COL-19](36-col-19-pause-tasks-for-human-input-and-approval.md)

## Acceptance criteria

- [ ] The application provides a valid manifest, icons, and service worker and passes browser installability checks.
- [ ] Desktop viewports support bot, group, knowledge, and audit administration without horizontal overflow in core flows.
- [ ] Mobile viewports can send group messages, resolve approvals, and inspect delegation trees and task outcomes.
- [ ] Offline mode displays only the cached shell and an explicit status and never presents a write as successful.
- [ ] On reconnection, the event stream resumes from the last event ID and fills the gap.
- [ ] Automated accessibility checks pass for keyboard navigation, visible focus, form labels, and core-page contrast.

## Non-goals

- Native iOS or Android applications
- Full offline operation
- Operating-system push notifications
