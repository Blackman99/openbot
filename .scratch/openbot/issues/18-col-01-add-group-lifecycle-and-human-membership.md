---
sequence: 18
id: COL-01
title: "Add group lifecycle and human membership"
status: complete
blocked_by:
  - WS-03
labels:
  - area:collaboration
  - area:groups
  - type:feature
  - mvp
  - implementation-complete
---

# COL-01 — Add group lifecycle and human membership

## Outcome

Users can create private or workspace-discoverable groups and manage explicit Owner, Admin, and Member roles through the API and UI.

## Blocked by

- [WS-03](05-ws-03-manage-workspace-members-and-roles.md)

## Acceptance criteria

- [x] Group creation defaults to private visibility.
- [x] Non-members cannot read a private group's metadata, content, or event stream.
- [x] Workspace-visible groups expose metadata only; reading content still requires membership.
- [x] Only group Owners and Admins can add or remove human members.
- [x] Removing a member immediately blocks future content reads and event subscriptions.
- [x] Removing a member preserves historical authorship and audit records.

Content and subscription admission are fresh database-backed seams; this ticket does not create conversation or event endpoints. Actual PostgreSQL concurrency and deployed-role execution remain the mandatory `COL-01-E1` release gate below.

## Non-goals

- Bot membership and history grants
- Public groups and guest access
- Bot configuration permissions

## Implementation decisions

- [COL-01-CONTRACT.md](../COL-01-CONTRACT.md) records the precise API, UI, data, and authority contracts. Groups default to private, support metadata editing, and have explicit `owner`, `admin`, and `member` human grants. Archive/deletion and conversation/SSE endpoints are deferred to their own scope; this ticket adds no placeholder events or messages.
- Every operation requires current workspace membership. Workspace owners and administrators have no implicit private-group access. Discoverable nonmembers receive group metadata only, while the human-member list and the database-backed content/subscription admission seams require an explicit group grant.
- Group mutations lock workspace then group, reread current authority, and commit their audit together with the material change. Last-owner checks count only owners who still have workspace access; inactive retained grants cannot satisfy that invariant. Workspace deprovisioning itself is not blocked by group ownership, and orphan repair has no implicit administrative bypass.
- Group removal deletes only the explicit group grant. Users, sessions, credentials, group creators, and audits remain. Workspace removal retains group grants but immediately denies every group access path; accepting a fresh workspace invitation restores still-explicit group grants. This policy is covered through the workspace removal and invitation-accept APIs.
- Provisional migration `0009_groups_and_human_memberships` follows AUTH-02 `0007` and PROV-02 `0008` before publication. The internal `throughVersion` migration fixture seam constructs a known historical prefix, rejects unknown/backward targets, and leaves the production CLI/default at latest; the 0006 backfill test no longer dismantles later schema.

## Verification record

- Witnessed red-first API tracers covered missing creation (404 → 201), metadata isolation (404 → 200/403), member content/subscription admission (404 → 403), membership addition (404 → 201), eligible-owner protection and role mutation (404 → 409/200), removal (404 → 409/204), and partial metadata edits (404 → 200). Each slice passed API types and its targeted tests before proceeding.
- On 2026-09-05, combined implementation candidate `e3677ad20c36d8469dec746dd1690a084c46a046` passed repository formatting, API/Web types with zero errors and warnings, API 68 unit + 139 integration tests, Web 17 unit + 105 integration tests (329 total), both production builds, and all 10 ordinary browser scenarios. Browser ports 4399/4173 were confirmed closed. The isolated base predates OIDC; root integration will run the unified OIDC gate.
- The UI uses fresh explicit group roles, renders discoverable nonmembers as metadata-only, limits admin authority, explains retained inactive grants, and preserves the session after workspace loss or explicit group self-removal. Its red-first client, action, loader, and rendered-control tests precede the browser lifecycle.
- Canonical UUID regressions first reproduced uppercase workspace IDs in create responses/audits and rejected canonical DTOs at the Web client boundary. Validated UUID scopes and targets are now normalized; arbitrary non-UUID fixture identifiers retain case-sensitive matching. The actual HTTP BFF-to-Fastify lifecycle verifies persistence, bodyless DELETE, current authority and owner protection; a stalled real HTTP group response verifies the deadline covers JSON consumption.
- Independent STANDARDS review is clean at `e3677ad`, including 25 independently passing API group/migration/deadline tests and 31 Web group tests. Independent SPEC review is also clean at that candidate, covering all six acceptance criteria and approved policy decisions, with 22 API + 31 Web tests passing. No review claims execution of PostgreSQL or Compose.
- [COL-01-VERIFICATION.md](../COL-01-VERIFICATION.md) records the complete restricted-runtime smoke recipe, exact payloads and privileges, ordered migration requirements, and external gate ownership.
- Historical migration fixture tests witnessed latest-schema leakage, an unknown-target database connection, and silent backward-target acceptance before their respective fixes; all now pass.

## External verification exception — COL-01-E1

- [x] Execute the three cases in `apps/api/tests/postgres/groups-runtime.test.ts` against actual PostgreSQL: concurrent last-owner demotions, owners removing each other with waiting-actor rechecks, and audit-failure rollback across creation, metadata, and every membership mutation.
- [x] Execute the root integration's Compose group lifecycle smoke through the deployed `openbot_runtime` role, including current workspace ∩ group ACL, no private-group administrative bypass, immediate workspace-removal denial, retained-grant re-invitation behavior, eligible-owner checks, and preserved authors/audits.
- [x] Assert exact privileges: groups SELECT/INSERT and column UPDATE(name, description, visibility, updated_at), no group DELETE/table-wide UPDATE or creator/identity UPDATE; human group membership SELECT/INSERT/DELETE and column UPDATE(role), no identity/join-time UPDATE; immutable audit protection remains intact.

These are mandatory `REL-01` release gates. The local PostgreSQL command currently skips 5 suites / 12 tests because test databases are unavailable. Mocked PostgreSQL and browser fixtures do not close these gates. Root integration owns the combined Compose extension and ordered migration-ledger assertion before this ticket is marked fully complete.

## Closed external evidence — COL-01-E1

COL-01-E1 closed by [Verify33945439831](https://github.com/Blackman99/openbot/actions/runs/33945439831), all five jobs successful on remote `4429ccdc8a61d6771b954c70dc0d6a1ab7b43873`, completed2026-09-05 at04:49:16 UTC. Published tree514ec8f9b70b5a760154171957ba566b0bf28242 exactly matches localf3d3671. The run passed539 code tests,14 ordinary browser scenarios plus one signed-IdP journey,16 auth/invitation/member/OIDC/group/token PostgreSQL cases,5 restricted provider cases, the separate OIDC privilege case and the complete fresh/upgrade/runtime-role/application/outage Compose flow.
