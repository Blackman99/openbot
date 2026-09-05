# COL-01 group API and UI contract

This is the approved implementation contract for ticket 18. It does not add messages, event streams, Bot membership, archive, or deletion.

## Data

- Group: `{ id, workspaceId, name, description, visibility, role, createdAt, updatedAt }`. IDs are canonical lowercase UUIDs and dates are ISO timestamps; valid uppercase UUID route/target inputs are normalized before database records, audit metadata, and scoped client comparisons. Visibility is `private` or `workspace`; role is the current caller's explicit `owner`, `admin`, `member`, or `null`.
- Group member: `{ user: { id, email, displayName }, role, joinedAt, hasWorkspaceAccess }`. A retained group grant can have `hasWorkspaceAccess: false` after workspace removal. It grants no current access. Workspace re-invitation restores a still-explicit group grant; explicit group removal deletes the grant.
- Names are trimmed, nonempty, and at most 100 characters. Descriptions are trimmed and at most 2,000 characters. Creation defaults description to empty and visibility to private.

## HTTP

All routes begin `/api/v1/workspaces/:workspaceId/groups`. Authentication uses the existing session cookie. Mutations require the exact configured web Origin. Responses are private/no-store.

| Method | Suffix | Input | Success |
|---|---|---|---|
| GET | empty | — | 200 `{ groups: Group[] }` |
| POST | empty | `{ name, description?, visibility? }` | 201 `{ group }` |
| GET | `/:groupId` | — | 200 `{ group }` |
| PATCH | `/:groupId` | Nonempty subset of `{ name, description, visibility }` | 200 `{ group }` |
| GET | `/:groupId/members` | — | 200 `{ members: GroupMember[] }` |
| POST | `/:groupId/members` | `{ userId, role? }`, default member | 201 `{ member }` |
| PATCH | `/:groupId/members/:userId` | `{ role }` | 200 `{ member }` |
| DELETE | `/:groupId/members/:userId` | No body | 204 |

Errors use `{ error: { code } }`: 401 `authentication_required`; 403 `group_forbidden` or `invalid_origin`; 400 `invalid_group_request`; 404 `group_member_not_found`; 409 `group_member_conflict` or `last_group_owner_required`. Treat transport/server errors as unavailable without exposing their bodies.

## Authority

- Current workspace membership is required for every group operation. Workspace owners/administrators receive no implicit private-group membership or management rights.
- Private metadata appears only to explicit group members. Discoverable groups expose only the Group DTO to other current workspace members (`role: null`), never the member list.
- Group owners/admins edit metadata and manage people. Owners can manage all group roles; admins can manage admins/members but cannot manage owners or grant ownership. Ordinary members cannot add, change, or remove people, including themselves.
- Prevent removal/demotion of the last currently eligible owner. Count owners with `hasWorkspaceAccess: true`; an inactive retained owner is not a replacement. Removing/demoting an inactive owner does not remove an eligible owner.
- Workspace deprovisioning is never blocked by group ownership. Private orphan repair and automatic ownership promotion are out of scope.
- Each mutation locks workspace, then group, and rereads current authority. Audits and material changes commit atomically; no-op metadata/role writes add no duplicate audit.
- `GroupService.authorizeContent` and `authorizeSubscription` perform fresh database authorization. They return snapshots, not durable capabilities. Future conversation/SSE consumers must authorize each read and subscription/resume; no placeholder event endpoint exists now.

## UI work boundary

Build `/app/workspaces/[workspaceId]/groups` for listing and creation, and its `/[groupId]` child for metadata and human membership. Add a workspace navigation link. Discoverable nonmembers get metadata only; do not call the content/member endpoint on their page. Read current role from the fresh member list before rendering controls. Manager candidate lists can use the existing workspace member API. Show retained grants that currently lack workspace access clearly.

On explicit self-removal by an authorized manager, return to the group's workspace list while retaining the session. On lost workspace/group permission, show 403 and retain a still-valid session. Only genuine 401 clears the cookie. No message composer, archive/delete UI, or future event affordances.

The BFF must set JSON Content-Type only when sending a body, and keep its timeout active through response JSON consumption. Preserve existing auth, invitation, member, and provider fixture hooks. Browser ports 4399/4173 require the root coordinator's lease.

## Integration notes

- Provisional migration `0009_groups_and_human_memberships` must follow AUTH-02 0007 and PROV-02 0008 before publication. Root may renumber only unpublished migrations.
- Internal migration option `throughVersion` supports known historical fixture prefixes, rejects unknown or older-than-current targets, and has no CLI/environment exposure. The 0006 backfill fixture now starts at 0005 and then migrates to latest without dismantling future tables.
- Real PostgreSQL concurrency/rollback and deployed-role Compose evidence remain required release gates; pg-mem and browser fixtures cannot prove them.
