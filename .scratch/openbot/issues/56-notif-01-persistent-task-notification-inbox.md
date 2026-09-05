---
sequence: 56
id: NOTIF-01
title: "Persistent task notification inbox"
status: blocked
blocked_by:
  - API-06
  - COL-19
labels:
  - area:notifications
  - area:frontend
  - kind:feature
  - priority:mvp
---

# NOTIF-01 — Persistent task notification inbox

## Outcome

Users receive and retain actionable notifications for approvals, task completion, failures, and exhausted budgets.

## Blocked by

- [API-06](53-api-06-resumable-permission-scoped-sse-event-stream.md)
- [COL-19](36-col-19-pause-tasks-for-human-input-and-approval.md)

## Acceptance criteria

- [ ] Pending approval, task completion, task failure, and budget exhaustion create persistent notifications for target users.
- [ ] One source event creates at most one notification per recipient, including after event replay.
- [ ] New notifications appear in real time and update the unread count without a page refresh.
- [ ] Users can paginate notifications and mark one or all as read.
- [ ] Read state survives refresh and reauthentication, and no other user can read or modify it.
- [ ] Opening a notification navigates to the referenced group, task, or approval after authorization is rechecked.

## Non-goals

- Email notifications
- Native mobile push
- Third-party messaging channels
