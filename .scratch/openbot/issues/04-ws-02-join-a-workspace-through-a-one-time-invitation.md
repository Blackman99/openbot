---
sequence: 4
id: WS-02
title: "Join a workspace through a one-time invitation"
status: ready-for-agent
blocked_by:
  - WS-01
labels:
  - workspace
  - auth
  - vertical-slice
  - mvp
  - ready-for-agent
---

# WS-02 — Join a workspace through a one-time invitation

## Outcome

Workspace owners and administrators can issue copyable invitation links that safely admit new or existing users.

## Blocked by

- [WS-01](03-ws-01-create-and-switch-isolated-workspaces.md)

`WS-01` implementation is complete under external verification exception `WS-01-E1`; its real PostgreSQL rollback/isolation and Compose runtime-role evidence remains a mandatory `REL-01` release gate.

## Acceptance criteria

- [ ] Owners and administrators can create, inspect, and revoke invitations with a target role and expiry; member requests return HTTP 403.
- [ ] Only an invitation token hash is stored, and the plaintext token appears once in the creation response.
- [ ] A new user can create a local account from a valid invitation, while a signed-in user can join through the same flow.
- [ ] With public registration disabled, no ordinary account or workspace membership can be created without a valid invitation.
- [ ] Expired, revoked, consumed, mismatched, and replayed invitations are rejected deterministically.
- [ ] A Playwright test places two users in one workspace, and invitation creation, acceptance, and revocation emit audit events.

## Non-goals

- Invitation email delivery
- Public guest links
- Enterprise directory synchronization
