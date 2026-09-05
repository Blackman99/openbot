---
sequence: 15
id: BOT-04
title: "Grant bot owner, editor, and user permissions"
status: complete
blocked_by:
  - BOT-01
  - WS-03
labels:
  - bot
  - rbac
  - security
  - vertical-slice
  - mvp
---

# BOT-04 — Grant bot owner, editor, and user permissions

## Outcome

An independent bot ACL governs ownership, editing, and use; workspace or group administration never implies bot edit access.

## Blocked by

- [BOT-01](12-bot-01-create-and-inspect-a-persistent-bot-identity.md)
- [WS-03](05-ws-03-manage-workspace-members-and-roles.md)

## Acceptance criteria

- [x] A bot owner can grant or revoke owner, editor, and user access for members of the same workspace and set private or workspace-visible scope.
- [x] Owners manage ACLs, edit, use, and delete; editors edit and use; users only inspect and use.
- [x] Workspace administrators and future group administrators cannot edit, delete, or manage a bot unless its ACL grants access.
- [x] Private bots are absent from unauthorized lists; workspace-visible bots expose only the configured discovery or use access.
- [x] ACL revocation or workspace removal takes effect on the next bot API request, and the last bot owner cannot be removed.
- [x] Two-user integration tests cover the full permission matrix, and every ACL or visibility change emits an audit event.

## Non-goals

- Group membership or group roles
- Public anonymous bots
- Cross-workspace ACLs

## Implementation evidence

Owner-only ACL and discovery settings are available under `/api/v1/workspaces/:workspaceId/bots/:botId/acl` and `/visibility`, with a permissions page linked from owner Bot detail. Current owner/editor/user authority is checked independently of workspace/group roles through BOT-01's transaction permission seam. Future edit/use/lifecycle permissions are tested there; BOT-03/06 endpoints are not introduced by this ticket.

Mutations lock workspace then Bot, reread current membership/ACL and eligible owners, and atomically audit effective changes. Inactive retained owners do not satisfy last-owner protection. Workspace removal remains possible, and configured discovery never confers inspect/use access. No schema migration was changed; runtime privileges add only Bot visibility updates, ACL role updates and ACL deletion.

At source `bd3ba9db5a0463fb52ff4711144c6db235142ca4`, all 651 unit/integration tests passed (API77+234; Web35+305), as did formatting, both typechecks and both production builds. The combined browser gate passed 17 ordinary scenarios and one signed-OIDC scenario. Browser ports were verified closed and released.

See [BOT-04-API-CONTRACT](../BOT-04-API-CONTRACT.md) and [BOT-04-VERIFICATION](../BOT-04-VERIFICATION.md). Independent Standards and Spec reviews are clean at source `bd3ba9db5a0463fb52ff4711144c6db235142ca4`; final `ee7adb1aaa062d37cf676421d17a9b75c41d7da3` changes only evidence. Dedicated merge `8d1933f51ff43c1c01616e8d885cf9ae75e41995` required no source fix and passed the full `pnpm verify`: 651 unit/integration tests, 17 ordinary browser scenarios, one signed-OIDC journey, formatting, types and builds. BOT-04-E1 remains an explicit REL-01 gate: all nine new native PostgreSQL cases were discovered but skipped locally without `TEST_BOT_DATABASE_URL`; actual restricted-role/concurrency/rollback and Compose execution must pass in CI.

BOT-04-E1 closed by [Verify33948405362](https://github.com/Blackman99/openbot/actions/runs/33948405362), all six jobs successful on remote `fa79a3dd85baf0dd2acf888d5f39a2a071d83fd8`, completed2026-09-05 at05:57:03 UTC. The published tree `040312fdf38cea26574dddc06a343b46d417d977` exactly matches local `86bdf75fa7b5b392f41af85e856b01e775991185`, verified by fetch and pinned diff. The dedicated postgres-bots job101258691651 executed the eight identity and nine ACL cases in separate successful commands. Compose job101258691734 passed fresh/upgrade startup, precise visibility and ACL role/delete privileges, and all prior application/outage checks; code, postgres-auth, postgres-providers and postgres-oidc also passed. This closes the external gate without counting local skips as execution; fifteen tickets are fully complete.
