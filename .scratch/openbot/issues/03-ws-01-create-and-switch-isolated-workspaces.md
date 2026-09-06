---
sequence: 3
id: WS-01
title: "Create and switch isolated workspaces"
status: complete
blocked_by:
  - AUTH-01
labels:
  - workspace
  - authorization
  - vertical-slice
  - mvp
  - implementation-complete
---

# WS-01 — Create and switch isolated workspaces

## Outcome

Authenticated users can create and switch workspaces while the server enforces workspace boundaries on every request.

## Blocked by

- [AUTH-01](02-auth-01-claim-an-instance-and-authenticate-a-local-owner.md)

`AUTH-01` implementation is complete under external verification exception `AUTH-01-E1`.

## Acceptance criteria

- [x] A user can create a workspace in the UI and becomes its sole owner.
- [x] Users can list only workspaces where they hold membership and switch through an explicit workspace route.
- [x] A valid workspace context survives refresh, while an invalid context falls back to an accessible workspace.
- [x] The API derives authorization from authenticated membership rather than client claims; cross-workspace access returns HTTP 403 or 404.
- [x] Integration tests write equivalent records in two workspaces and prove they are mutually invisible.
- [x] Workspace creation and material setting changes emit audit events without sensitive content.

## Non-goals

- Member invitations or role changes
- Cross-workspace bot or knowledge sharing
- Workspace deletion or retention policy

## Implementation and local evidence — 2026-09-05

- Added `GET/POST /api/v1/workspaces` and `GET/PATCH /api/v1/workspaces/:workspaceId`. Every request resolves the session; reads join current membership, writes derive the actor from the session, and only owners/administrators may change settings. Client owner/role/workspace claims cannot grant access.
- Added `/app/workspaces/:workspaceId` with membership-scoped navigation, creation, and name/description settings. `/app` and inaccessible route contexts redirect to an accessible workspace; an explicit valid context survives refresh. Responses are private and non-cacheable.
- Migration `0003_workspace_settings` adds descriptions and a membership user index. Creation includes the owner membership and audit in one transaction. Settings updates lock the workspace row and append an audit only for changed fields; audit metadata contains IDs and field names, never names or description contents.
- `apps/api/tests/integration/workspaces.test.ts` covers sole ownership, two users with equivalent records in two mutually invisible workspaces, cross-workspace read/write rejection including instance admins, immediate membership revocation, safe audits/no-op updates, and malformed/anonymous/cross-site requests.
- Red→green evidence: creation returned 404 before 201; workspace listing returned 404 before membership-scoped 200; settings PATCH returned 404 before authorized 200; `/app` returned an identity before its explicit-route redirect; workspace controls were absent before rendering; browser setup initially reached a 503 until its fixture gained workspace APIs.
- Final `pnpm verify` passed: API unit **46/46**, Web unit **7/7**, API integration **41/41**, Web integration **25/25**, browser **5/5**, formatting, strict types, and both production builds. The workspace browser journey covers create → switch → refresh → edit → invalid-context fallback and asserts no browser runtime errors.
- Fixed two observed verification issues: Playwright now uses one worker because the live fixture has shared instance state; optional adapter precompression is disabled after a generated zero-byte Brotli sidecar caused missing-module-export errors and hydration corruption. The final browser gate passed with no runtime errors.
- Root review of the API, membership repository, Web routes, and acceptance coverage found no deterministic blocker. Final unified-branch two-axis review remains part of the implementation workflow.

## External verification exception — WS-01-E1

The local criteria above have API/pg-mem/SSR/browser evidence. Actual PostgreSQL transaction rollback and the deployed runtime role remain external release evidence, extending the existing FND-01-E1/AUTH-01-E1 gate:

- [x] Run the added real PostgreSQL workspace isolation and failed-audit rollback test in `apps/api/tests/postgres/auth-runtime.test.ts`.
- [x] Run the Compose workspace create/update smoke using `openbot_runtime`; verify UPDATE is granted only on workspace name/description and audit content is safe.

These tests are wired into Verify and were not executed locally because PostgreSQL/Docker are unavailable. `REL-01` must close this external evidence before release.

## Downstream handoff

WS-03 must separate authenticated identity from workspace membership: the inherited AUTH query currently joins memberships, so losing the last membership makes the session resolve as anonymous. Member/role mutation must also share the workspace row-lock protocol used by settings updates. This ticket does not add member removal or role-management endpoints.

## External evidence closed — 2026-09-05

Verify [33938570768](https://github.com/Blackman99/openbot/actions/runs/33938570768) on published commit `ecc586a8d3b528728af2308e247c4c3c4fb75ffa` passed `code`, `postgres-auth`, and `compose` at 02:17 UTC. This closes the previously documented external verification exception. The complete gate includes real PostgreSQL atomicity/rollback, workspace isolation, append-only audit enforcement, fresh and upgrade Compose startup, runtime-role/password/session checks, workspace changes, and database outage behavior. Earlier unavailable-runtime notes above describe the local implementation stage; they no longer block this ticket.
