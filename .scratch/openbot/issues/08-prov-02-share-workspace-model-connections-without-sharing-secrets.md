---
sequence: 8
id: PROV-02
title: "Share workspace model connections without sharing secrets"
status: ready-for-agent
blocked_by:
  - PROV-01
  - WS-03
labels:
  - provider
  - workspace
  - rbac
  - security
  - vertical-slice
  - mvp
---

# PROV-02 — Share workspace model connections without sharing secrets

## Outcome

Workspace owners and administrators can manage shared model connections while members receive usage access without credential access.

## Blocked by

- [PROV-01](07-prov-01-connect-a-personal-openai-chat-compatible-model.md)
- [WS-03](05-ws-03-manage-workspace-members-and-roles.md)

## Acceptance criteria

- [ ] Owners and administrators can create, test, update, and disable workspace connections; member management requests return HTTP 403.
- [ ] Workspace members can read only redacted protocol, model, capability, and health metadata; no API returns ciphertext or plaintext secrets.
- [ ] Usage permission is separate from credential access: authorized members can run probes but cannot edit credentials.
- [ ] Non-members and newly removed members immediately lose access to connection lists, details, and invocation.
- [ ] Disabling a connection blocks new calls while dependent objects retain an explicit unavailable state.
- [ ] Two-user integration tests cover creation, updates, tests, grants, and disabling, with secret-free audit events.

## Non-goals

- Sharing one connection across workspaces
- Exporting connection secrets
- Executing automatic failover
