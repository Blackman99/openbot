---
sequence: 18
id: COL-01
title: "Add group lifecycle and human membership"
status: blocked
blocked_by:
  - WS-03
labels:
  - area:collaboration
  - area:groups
  - type:feature
  - mvp
---

# COL-01 — Add group lifecycle and human membership

## Outcome

Users can create private or workspace-discoverable groups and manage explicit Owner, Admin, and Member roles through the API and UI.

## Blocked by

- [WS-03](05-ws-03-manage-workspace-members-and-roles.md)

## Acceptance criteria

- [ ] Group creation defaults to private visibility.
- [ ] Non-members cannot read a private group's metadata, content, or event stream.
- [ ] Workspace-visible groups expose metadata only; reading content still requires membership.
- [ ] Only group Owners and Admins can add or remove human members.
- [ ] Removing a member immediately blocks future content reads and event subscriptions.
- [ ] Removing a member preserves historical authorship and audit records.

## Non-goals

- Bot membership and history grants
- Public groups and guest access
- Bot configuration permissions
