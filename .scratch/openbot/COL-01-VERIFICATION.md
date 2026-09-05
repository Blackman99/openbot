# COL-01 verification and integration handoff

## Local evidence

- API implementation checkpoint `a12413b` passed 68 unit and 134 integration tests, API types, and formatting. Its red-first tracers covered creation, metadata visibility, content/subscription admission, addition, roles/eligible-owner protection, removal, and metadata updates.
- `2d28739` passed API types and 14 focused tests: 11 group integration cases, including the real HTTP `GroupApiClient` lifecycle, and three stalled real HTTP response-body deadline cases for members, invitations, and groups. An uppercase workspace UUID first failed the canonical response assertion; service normalization then passed the response and audit regressions.
- The internal migration `throughVersion` tests witnessed failure for historical-prefix construction, unknown-target connection avoidance, and backward-target rejection before the implementation passed. The 0006 backfill fixture now migrates through 0005 and forward without deleting future schema.
- On 2026-09-05, combined candidate `e3677ad20c36d8469dec746dd1690a084c46a046` passed repository formatting, API/Web types (zero errors/warnings), API 68 unit + 139 integration tests, Web 17 unit + 105 integration tests (329 total), and both production builds. All 10 ordinary browser scenarios passed in 33.1 seconds, including the full group lifecycle. Both browser ports were confirmed closed afterward. OIDC is absent from this older isolated base; root integration will run the combined OIDC gate.
- Independent STANDARDS review is clean on `e3677ad`, with an independent rerun of 25 API group/migration/deadline tests and 31 Web group client/route/rendering tests. Independent SPEC review is also clean at the same candidate, covering all six acceptance criteria and approved retained-grant policy, with 22 API and 31 Web tests independently passing. Actual PostgreSQL and deployed-role evidence remains separate below.

## Required external evidence: COL-01-E1

Local PostgreSQL tests are skipped because `TEST_DATABASE_URL` is unavailable. The three cases in `apps/api/tests/postgres/groups-runtime.test.ts` must run against actual PostgreSQL using:

```sh
pnpm --filter @openbot/api exec vitest run tests/postgres/groups-runtime.test.ts
```

They prove concurrent self-demotions preserve one eligible owner, concurrent reciprocal removals recheck the waiting actor, and failed mandatory audit insertion rolls back creation, metadata, addition, role changes, and removal. These admin-backed tests do not prove deployed runtime grants; the Compose smoke below is a separate required gate.

## Compose smoke recipe for the root merger

Use the deployed API, existing configured web Origin, and real session cookie jars. Create isolated users through the existing invitation flow: A is a workspace owner; B, C, and D are ordinary workspace members. B must have only this workspace to make the no-workspace session assertion deterministic. Keep the group UUID and user UUIDs from actual responses. All paths below begin `/api/v1/workspaces/{workspaceId}/groups`.

1. B sends `POST` with `{ "name": "Compose group" }`. Assert 201, private visibility, empty description, and role `owner`. As A, GET the group and its `/members` both return 403 `group_forbidden`; workspace ownership creates no group grant.
2. B sends `PATCH /{groupId}` with `{ "description": "Runtime membership smoke", "visibility": "workspace" }`. Assert the name remains unchanged. A can GET metadata with `role: null` and see it in the list, while `/members` still returns 403.
3. B sends `POST /{groupId}/members` with `{ "userId": "{C}", "role": "admin" }`. C adds D as `member`, using the same endpoint. D's metadata/member mutations return 403. C cannot grant D `owner` or mutate owner B (403). A remains a metadata-only nonmember.
4. C sends a bodyless `DELETE /{groupId}/members/{D}` and receives 204. D's `/members` becomes 403, while discoverable metadata remains 200 with `role: null`. Re-adding D and repeating the addition must yield 409 `group_member_conflict` without changing the role. C's successful removal exercises runtime DELETE independently from the BFF client-to-real-HTTP regression.
5. B promotes C with `PATCH /{groupId}/members/{C}` and `{ "role": "owner" }`. A removes B through the workspace-member endpoint. B's session remains valid: `/api/v1/me` returns 200 with `workspace: null`. B's group list, metadata, and member list return 403. The B group grant and original creator ID remain in PostgreSQL.
6. C is now the only eligible group owner. C's self-demotion and self-removal both return 409 `last_group_owner_required`; B's retained but workspace-ineligible owner grant cannot satisfy the invariant. Workspace removal itself was allowed in step 5.
7. A creates a fresh email-bound workspace invitation for B. B accepts it while authenticated with `POST /api/v1/invitations/accept` and `{ "token": "{freshToken}" }`; assert 200 and the original user ID. B's still-explicit group grant becomes active again, with owner access. No group invitation or implicit grant is created by this operation.
8. C explicitly removes B from the group, then makes visibility private. B's metadata and member list now return 403 despite current workspace membership. B's user, local credential, session, original group creator ID, and existing audit rows remain; the explicit group grant is absent. A still has no private-group bypass.
9. Use the Compose administrator connection to verify material `group.created`, `group.metadata_changed`, `group.member_added`, `group.member_role_changed`, and `group.member_removed` audits. Filter by the new group ID, and assert canonical group/workspace/target UUID fields with no credentials, cookie, password, email, or token material. Repeating a no-op role or metadata update must not add a duplicate audit. Existing immutable-audit trigger and runtime audit-SELECT denial assertions remain intact.

`GroupService.authorizeContent` and `authorizeSubscription` are fresh database admission seams. The three actual PostgreSQL cases exercise these seams after group removal; there is intentionally no placeholder conversation or SSE endpoint to call in Compose.

## Exact database privileges and migration order

The actual `grant-runtime-privileges.mjs` contains these grants; the integration workflow must assert them through catalog queries under its administrator connection:

| Relation | SELECT | INSERT | table-wide UPDATE | DELETE | TRUNCATE | column UPDATE |
|---|---|---|---|---|---|---|
| `groups` | true | true | false | false | false | `name`, `description`, `visibility`, `updated_at` only |
| `group_memberships` | true | true | false | true | false | `role` only |
| `audit_events` | false | true | false | false | false | none |

Alphabetically ordered column privilege expectations are:

```text
groups: created_at:false,created_by_user_id:false,description:true,id:false,name:true,updated_at:true,visibility:true,workspace_id:false
group_memberships: created_at:false,group_id:false,role:true,user_id:false
```

The published ledger must contain AUTH-02 0007, PROV-02 0008, then provisional `0009_groups_and_human_memberships`. Preserve the internal historical `throughVersion` fixture seam and dynamic migration-ledger fixtures during integration. The CLI/default still migrates to latest and offers no backwards/target override.

Root integration owns the combined Compose extension, ordered ledger assertion, and final CI execution. COL-01-E1 remains open until all actual PostgreSQL and deployed-role checks pass; local pg-mem and browser fixtures do not close it.

## Combined integration

Integrated `b7dc8fe0bd7381280091c2c87883968de9e7b3f9` passed 445 unit/integration tests (77 API unit, 23 Web unit, 175 API integration, 170 Web integration), 11 ordinary browser scenarios and one real signed-IdP journey, formatting, types and both production builds. Workflow YAML and all 23 shell steps passed syntax checks. Root independently reviewed the new Compose lifecycle/grants/ledger and nine exact group audits. Migration0009 follows0007/0008, and the internal throughVersion fixture now constructs the true historical0005 schema before the0006 backfill. COL-01-E1 remains explicit in REL-01 pending actual CI.
