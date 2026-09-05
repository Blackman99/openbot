---
sequence: 5
id: WS-03
title: "Manage workspace members and roles"
status: blocked
blocked_by:
  - WS-02
labels:
  - workspace
  - rbac
  - security
  - vertical-slice
  - mvp
---

# WS-03 — Manage workspace members and roles

## Outcome

Workspaces manage members through owner, administrator, and member roles, with authorization changes taking effect immediately.

## Blocked by

- [WS-02](04-ws-02-join-a-workspace-through-a-one-time-invitation.md)

## Acceptance criteria

- [ ] The members page lists only the current workspace's members, roles, and invitation sources.
- [ ] Owners and administrators can change roles or remove members only within their authority; member requests return HTTP 403.
- [ ] The system prevents removal or demotion of the last owner and prevents users from granting roles above their own.
- [ ] After removal, the user's next API request to that workspace returns HTTP 403 even from an existing session.
- [ ] Role changes use transactions and concurrency protection so simultaneous requests cannot leave a workspace without an owner.
- [ ] Integration tests cover listing, role changes, removal, and last-owner protection, and every mutation emits an audit event.

## Non-goals

- Bot-level owner, editor, and user ACLs
- SAML or SCIM
- Global organization roles across workspaces
