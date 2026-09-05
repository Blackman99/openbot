---
sequence: 4
id: WS-02
title: "Join a workspace through a one-time invitation"
status: complete
blocked_by:
  - WS-01
labels:
  - workspace
  - auth
  - vertical-slice
  - mvp
  - implementation-complete
---

# WS-02 — Join a workspace through a one-time invitation

## Outcome

Workspace owners and administrators can issue copyable invitation links that safely admit new or existing users.

## Blocked by

- [WS-01](03-ws-01-create-and-switch-isolated-workspaces.md)

`WS-01` and its baseline real PostgreSQL/Compose evidence passed Verify run `33938570768`. This ticket adds separate invitation-specific runtime evidence below.

## Acceptance criteria

- [x] Owners and administrators can create, inspect, and revoke invitations with a target role and expiry; member requests return HTTP 403.
- [x] Only an invitation token hash is stored, and the plaintext token appears once in the creation response.
- [x] A new user can create a local account from a valid invitation, while a signed-in user can join through the same flow.
- [x] With public registration disabled, no ordinary account or workspace membership can be created without a valid invitation.
- [x] Expired, revoked, consumed, mismatched, and replayed invitations are rejected deterministically.
- [x] A Playwright test places two users in one workspace, and invitation creation, acceptance, and revocation emit audit events.

## Non-goals

- Invitation email delivery
- Public guest links
- Enterprise directory synchronization

## Implementation decisions

- Invitations target a normalized, exact email and grant `member` or `administrator`; ownership is not granted by an invitation. Expiry is an integer from 1 through 30 days (UI default: 7 days).
- Creation returns a random 256-bit token once. Only its SHA-256 digest is persisted. Management responses omit both the token and digest; audit metadata includes workspace/invitation IDs and target role, without email or credentials.
- Management routes are `/api/v1/workspaces/:workspaceId/invitations` (POST/GET) and its `/:invitationId` child (DELETE). Members receive HTTP 403; non-members cannot inspect another workspace's invitations.
- Acceptance uses POST `/api/v1/invitations/accept` with the token in the body. A signed-in account must match the target email; unauthenticated acceptance creates a new local account and session atomically. Existing emails require sign-in and are never merged or given a replacement password.
- Account creation, membership, session, consumption and audits share one database transaction. All invitation mutations lock the workspace before the invitation, and acceptance rechecks state and expiry after acquiring the locks. Duplicate membership does not change an existing role. Replay, consumed/revoked/expired/mismatched tokens produce the same HTTP 409 response.
- The UI uses `/join#token=...`; fragments never enter server request URLs. Plaintext tokens and passwords are not returned in action failures. Public account registration remains unavailable.
- Migration `0005_workspace_invitations` must be integrated after concurrent provider migration `0004`; it must not be deployed first and followed by inserting an earlier ledger entry.

## Verification record

- Witnessed red-first API tracers: missing create/list endpoint (404 → 201); missing acceptance (404 → 201); missing revoke (404 → 204); absent attempt throttling (409 → 429); expiry after lock wait (incorrect acceptance → rejection); unrelated browser cookie (401 → successful invited signup); administrator demotion between authorization and list (email disclosure → no results).
- Final `pnpm verify` on 2026-09-05 passed: API 46 unit + 51 integration tests (10 invitation cases), Web 9 unit + 53 integration tests, all 6 browser journeys, formatting, strict types and both production builds. The invitation browser journey places two users in one workspace, accepts another invitation after signing in to the existing account in place, rejects revoked invitations, and checks tokens never appear in request URLs.
- Real PostgreSQL tests use an isolated schema and cover concurrent single-use consumption, revoke/accept races, identical-email signup across workspaces, and rollback without consuming the invitation. They are wired into the existing `test:postgres` CI command and are not claimed as locally executed.
- Required external gate `WS-02-E1`: actual PostgreSQL concurrency/rollback tests plus Compose create/accept/revoke/replay and minimum-privilege checks under `openbot_runtime`. The root integration adds the Compose smoke before marking this ticket complete; mocked PostgreSQL and browser fixtures do not close this gate.

- Independent standards and spec reviews are clean through implementation commit `8b4713c`. Two standards findings were fixed and rechecked: sign-in, owner setup and invited signup now share one two-operation password budget; invitation HTTP 429 preserves validated Retry-After and a retryable form without returning credentials.
- Browser red→green evidence: a `no-referrer` policy remained in effect after enhanced navigation and caused native sign-out POST to send `Origin: null`. The join page now uses `same-origin`; actual Origin headers on both enhanced acceptance and native sign-out are asserted without weakening server Origin checks. Test Chromium no longer disables web security.

## Closed external verification — WS-02-E1

- [x] Execute `apps/api/tests/postgres/invitations-runtime.test.ts` against real PostgreSQL; prove one winner in consumption/revocation/account-uniqueness races and complete rollback on account failure.
- [x] Execute the root integration's Compose invitation create/accept/revoke/replay smoke and minimum-privilege assertions using the deployed `openbot_runtime` role.

These gates passed in [Verify33941168646](https://github.com/Blackman99/openbot/actions/runs/33941168646) on published commit `98f15fc88cdc44bc6cd14ac5542a9aad3fb58166`, completed on 2026-09-05 at 03:13:55 UTC. The authentication job executed 2 authentication and 2 invitation PostgreSQL tests. Compose executed the invitation flow using the deployed restricted runtime role and verified its exact column privileges. Integrated local revision `62b0ab6` also passed 186 unit/integration tests and 7 browser scenarios before publication.

## Downstream handoff

- WS-03 membership/role mutations must share the workspace row-lock ordering with invitation create/revoke/accept and workspace settings; identity must remain valid independently of membership as already recorded by WS-01.
- AUTH-02 can extend the `InvitationAccept` transaction seam in `apps/api/src/invitations/service.ts` for an OIDC-created account without local credentials. Currently `newAccount` intentionally implements only local registration; existing-user acceptance validates both authenticated user ID and exact normalized email and never links or selects an account by email alone.
- Preserve the provider fixture hooks and registration/grants from concurrent PROV-01 when integrating this branch; migration order must be `0004` then `0005`.
