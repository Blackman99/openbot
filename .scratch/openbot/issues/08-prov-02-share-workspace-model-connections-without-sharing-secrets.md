---
sequence: 8
id: PROV-02
title: "Share workspace model connections without sharing secrets"
status: complete-with-external-verification
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
  - implementation-complete
---

# PROV-02 — Share workspace model connections without sharing secrets

## Outcome

Workspace owners and administrators can manage shared model connections while members receive usage access without credential access.

## Blocked by

- [PROV-01](07-prov-01-connect-a-personal-openai-chat-compatible-model.md)
- [WS-03](05-ws-03-manage-workspace-members-and-roles.md)

## Acceptance criteria

- [x] Owners and administrators can create, test, update, and disable workspace connections; member management requests return HTTP 403.
- [x] Workspace members can read only redacted protocol, model, capability, and health metadata; no API returns ciphertext or plaintext secrets.
- [x] Usage permission is separate from credential access: authorized members can run probes but cannot edit credentials.
- [x] Non-members and newly removed members immediately lose access to connection lists, details, and invocation.
- [x] Disabling a connection blocks new calls while dependent objects retain an explicit unavailable state.
- [x] Two-user integration tests cover creation, updates, tests, grants, and disabling, with secret-free audit events.

## Non-goals

- Sharing one connection across workspaces
- Exporting connection secrets
- Executing automatic failover


## Implementation and verification

Code is implemented through `73a4434112561ef6585ca3e108be8835f6cc4bb4`. The preceding combined
candidate passed 331 unit/integration tests, formatting/typechecks, serial builds, and all ten browser
scenarios. The UUID review fix adds one HTTP regression and passes 23 affected tests plus API
typecheck/build/lint. Workspace membership is the usage grant; no credential-sharing API or
per-connection grant table is introduced. Disabled identities remain available with explicit
unavailable state for later dependent objects.

Both independent Standards and Spec reviews are clean at `73a4434`. The original Standards reviewer
confirmed the UUID/AAD fix with 12 independent route/personal-connection tests and direct historical
personal-AAD checks. Integrated revision `3c515b6` passed all 400 unit/integration tests, 10 ordinary
browser scenarios, one real signed-IdP journey, formatting, types and production builds. The new
Compose privilege assertions passed independent root review. Actual PostgreSQL/Compose gate
`PROV-02-E1` remains explicit in REL-01; it permits local PROV-05 implementation while CI runs.

See [PROV-02-VERIFICATION.md](../PROV-02-VERIFICATION.md) for exact evidence, the initial resource
contention timeout and successful serial rerun, migration 0007/0008 integration seams, and explicit
external gates. Root owns index/PROGRESS/release closure metadata.
