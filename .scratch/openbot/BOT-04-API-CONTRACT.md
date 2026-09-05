# BOT-04 ACL and visibility contract

Base: BOT-01 integrated at `47553b1e5331aeaa869d44e96537b38d53d9fd2b`. BOT-CONTRACT remains authoritative. This ticket adds owner-managed ACLs and discovery visibility; avatar editing/version append and lifecycle endpoints belong to their existing tickets.

## HTTP and DTOs

All paths start `/api/v1/workspaces/:workspaceId/bots/:botId`. Every request uses the session cookie; mutations require exact configured web Origin. Responses are private/no-store. Validate and canonicalize UUIDs before scoped comparisons and persistence; audits use database identity.

| Method | Suffix | Input | Success |
| --- | --- | --- | --- |
| GET | `/acl` | none | 200 `{ members: BotAclMember[] }` |
| POST | `/acl` | `{ userId, role? }`, default `user` | 201 `{ member: BotAclMember }` |
| PATCH | `/acl/:userId` | `{ role }` | 200 `{ member: BotAclMember }` |
| DELETE | `/acl/:userId` | no body | 204 |
| PATCH | `/visibility` | `{ visibility: 'private' \| 'workspace' }` | 200 `{ visibility }` |

`BotAclMember = { user: { id, email, displayName }, role: 'owner' | 'editor' | 'user', joinedAt: ISO date, hasWorkspaceAccess: boolean }`.

Errors use `{ error: { code } }`: 401 `authentication_required`; 403 `invalid_origin` or `bot_forbidden`; 400 `invalid_bot_request`; 404 `bot_acl_member_not_found`; 409 `bot_acl_conflict` or `last_bot_owner_required`; 503 `bot_unavailable`. Match HTTP status to code; unexpected bodies/statuses are unavailable. A missing or inaccessible Bot yields the same 403. ACL target details are available only after owner admission.

## Authority and persistence

- Every operation requires current workspace membership and the explicit current owner ACL. Workspace and group administration add no rights. Direct editors/users retain inspect/use; editors additionally edit through the existing transaction seam.
- New grants/promotions target current same-workspace members. Retained inactive grants appear with `hasWorkspaceAccess: false`; removing/demoting them does not remove an eligible owner. Inactive targets cannot gain privileges. Explicit ACL revocation deletes the grant; workspace removal retains it but disables access. A real workspace rejoin restores only still-explicit grants.
- Last-owner protection counts only explicit owners with current workspace membership. Workspace removal remains possible; no automatic administrator takeover.
- Lock workspace then Bot using `lockAuthorizedBot(..., 'manageAcl')`; reread targets and current eligible owners after lock admission. Changes and required audits share the transaction. No-op role/visibility writes add no audit.
- Audits: `bot.acl_granted` contains Bot/workspace/target IDs and role; `bot.acl_role_changed` includes fromRole/toRole; `bot.acl_revoked` includes removed role; `bot.visibility_changed` includes fromVisibility/toVisibility. Never audit instructions, credentials or full configuration.
- Visibility affects only metadata discovery. It never changes the Bot version/pointer or grants use, configuration inspection, editor or owner rights. No schema migration: deployed role grants add only bots UPDATE(visibility), bot_acl UPDATE(role) and DELETE.

## Web boundary

Build `/app/workspaces/[workspaceId]/bots/[botId]/permissions` with owner-only access and a link from owner Bot detail. Load current Bot identity, ACL and workspace candidates; use explicit role controls and private/workspace discovery choices. Explain retained grants without workspace access. Show last-owner and conflict errors without losing session; only genuine 401 clears the session cookie. Self-removal returns to the Bot workspace list; self-demotion returns to Bot detail.

Use a separate strict `bot-acl-api.ts` client and `bot-acl-page.ts` page helper. JSON Content-Type only accompanies a body, and deadline remains active until body decoding completes. Preserve existing BOT-01 fixtures/hooks. Browser ports require root lease. Native BOT-04 tests use a new file and root will add it serially to the fixed-role Bot CI job.
