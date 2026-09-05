---
sequence: 5
id: WS-03
title: "Manage workspace members and roles"
status: complete
blocked_by:
  - WS-02
labels:
  - workspace
  - rbac
  - security
  - vertical-slice
  - mvp
  - implementation-complete
---

# WS-03 — Manage workspace members and roles

## Outcome

Workspaces manage members through owner, administrator, and member roles, with authorization changes taking effect immediately.

## Blocked by

- [WS-02](04-ws-02-join-a-workspace-through-a-one-time-invitation.md)

## Acceptance criteria

- [x] The members page lists only the current workspace's members, roles, and invitation sources.
- [x] Owners and administrators can change roles or remove members only within their authority; member requests return HTTP 403.
- [x] The system prevents removal or demotion of the last owner and prevents users from granting roles above their own.
- [x] After removal, the user's next API request to that workspace returns HTTP 403 even from an existing session.
- [x] Role changes use transactions and concurrency protection so simultaneous requests cannot leave a workspace without an owner.
- [x] Integration tests cover listing, role changes, removal, and last-owner protection, and every mutation emits an audit event.

The transaction mechanism is implemented and has explicit real PostgreSQL concurrency tests; execution of that evidence and restricted-role checks remains the mandatory `WS-03-E1` release gate below.

## Non-goals

- Bot-level owner, editor, and user ACLs
- SAML or SCIM
- Global organization roles across workspaces

## Implementation decisions

- Membership identity and authorization are separate. A valid session remains valid after its last workspace membership is removed: `/api/v1/me` returns HTTP 200 with `workspace: null`, while protected requests to the former workspace return HTTP 403. Local sign-in also remains available. Removing membership does not delete users, credentials, sessions, historical invitations, or audit authors.
- Every current workspace member may list members. Owners may manage all three roles; administrators may manage administrators and members, including themselves, but cannot manage owners or grant ownership. Members cannot mutate membership. The last owner's removal or demotion returns HTTP 409 with `last_owner_required`.
- GET `/api/v1/workspaces/:workspaceId/members` returns `{ members }`. Each entry has `{ user: { id, email, displayName }, role, joinedAt, invitation }`, where invitation is either `null` or `{ id, invitedBy: { id, displayName } }`. PATCH `/:userId` accepts `{ role }` and returns `{ member }`; DELETE `/:userId` returns HTTP 204.
- Each role change or removal locks the workspace row first, then reads the actor, target, and owner count inside the transaction. This shares the lock ordering of workspace settings and invitations and rechecks a waiting actor's current authority. Successful material mutations and their audit inserts commit together. Repeating the current role produces no mutation and no redundant audit event.
- Migration `0006_workspace_member_provenance` records the accepted invitation on the membership. Existing accepted memberships are backfilled only where workspace, consumed user, and acceptance timestamp match; removal and re-invitation point the new membership to its fresh invitation without rewriting history. AUTH-02 migration `0007` must follow this migration.
- The runtime database role gains DELETE on `workspace_memberships` and UPDATE on its `role` column only. Membership identity, join time, and invitation provenance remain outside UPDATE privileges.

## Verification record

- Witnessed red-first tracers: a valid session disappeared after its last membership was removed (undefined → valid identity with null workspace); the Web auth parser rejected that identity (unavailable → authenticated); missing member listing (404 → 200); missing role mutation (404 → correct 403/200 boundaries); last-owner demotion incorrectly succeeded (200 → 409); missing removal (404 → 204 plus retained-session evidence).
- Final `pnpm verify` passed on 2026-09-05 at implementation commit `7d6d0dd6fc7840d75132c4208749d146d0991152`: API 52 unit + 79 integration tests, Web 13 unit + 77 integration tests (221 total), all 8 browser journeys, strict type checking, repository formatting, and both production builds. Membership coverage proves current-workspace listing and invitation provenance, authority hierarchy, immediate role checks, last-owner protection, removal with retained identity/history, safe re-invitation, malformed and cross-origin requests, and material-change audits. Migration upgrade coverage verifies existing invitation provenance backfill.
- `apps/api/tests/postgres/members-runtime.test.ts` adds three real PostgreSQL cases for simultaneous last-owner demotions, owners removing each other with waiting-actor authorization checks, and rollback when mandatory audit insertion fails. The local PostgreSQL command reports 4 suites / 8 tests skipped because no test database is configured; this is not execution evidence for concurrency or deployed permissions.
- Independent standards review found two Web transport defects, both also present in the invitation client. Real HTTP regressions first proved bodyless DELETE was rejected by Fastify's empty-JSON parser and that stalled response bodies outlived the client's timeout. Both clients now set JSON Content-Type only for requests with bodies and consume JSON within their existing 30-second deadline. Four added regressions cross actual HTTP, including persisted membership removal, persisted invitation revocation, and stalled-body deadlines for both clients; all passed after the fixes.
- Independent standards review is clean through `7d6d0dd6fc7840d75132c4208749d146d0991152`, including an independent rerun of 10 API and 29 Web client tests. Independent spec review was clean at `a55ca3b`; root reviewed the five-file transport fix delta through `7d6d0dd` and confirmed preserved status, cookie, payload, and acceptance-criteria contracts. The final browser run passed after both fixes, and test ports 4399/4173 were confirmed closed.

## Closed external verification — WS-03-E1

- [x] Execute `TEST_DATABASE_URL=postgresql://… pnpm --filter @openbot/api run test:postgres` against actual PostgreSQL, including all three membership concurrency/rollback cases.
- [x] Execute the root integration's Compose membership lifecycle smoke under `openbot_runtime`: list provenance, promote/demote/remove, reject administrator changes to owners, reject last-owner removal/demotion, retain the removed user's session, return `/me` HTTP 200 with `workspace: null`, and return former-workspace HTTP 403.
- [x] Verify runtime membership DELETE and column `role` UPDATE privileges, reject table-wide UPDATE and UPDATE of `workspace_id`, `user_id`, `created_at`, and `invitation_id`, and retain immutable audit protection.

All gates closed by [Verify33942927588](https://github.com/Blackman99/openbot/actions/runs/33942927588), successful on remote `027afbfb71e29d7f27d8249d5a72ddaa39adb332` at 2026-09-05 03:52:14 UTC. All four jobs passed, including seven real authentication/invitation/member tests and the deployed-role Compose member smoke and exact migration-ledger assertions. Final REL-01 acceptance remains required on the final integrated revision.
