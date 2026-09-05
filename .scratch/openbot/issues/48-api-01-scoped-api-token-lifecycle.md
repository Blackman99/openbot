---
sequence: 48
id: API-01
title: "Scoped API token lifecycle"
status: blocked
blocked_by:
  - WS-03
labels:
  - area:api
  - area:security
  - kind:feature
  - priority:mvp
---

# API-01 — Scoped API token lifecycle

## Outcome

Workspace members can create, inspect, and revoke scoped API tokens whose plaintext is revealed only once.

## Blocked by

- [WS-03](05-ws-03-manage-workspace-members-and-roles.md)

## Acceptance criteria

- [ ] The creation response is the only place the full token appears; plaintext is absent from the database, audit records, and application logs.
- [ ] Each token is bound to its creator and one workspace, with a name, fixed scopes, expiration, and last-used timestamp.
- [ ] Expired, revoked, forged, or orphaned tokens receive 401 from /v1/me.
- [ ] A token missing the required scope receives 403 and causes no target-resource mutation.
- [ ] The settings UI can create a token, copy its one-time secret, list redacted metadata, and revoke it.
- [ ] Creation, use, and revocation emit security audit events without secret material.

## Non-goals

- Third-party OAuth authorization
- Independent service accounts
- Tokens in URL query parameters
