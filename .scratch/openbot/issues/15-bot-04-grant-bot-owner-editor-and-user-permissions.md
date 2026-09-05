---
sequence: 15
id: BOT-04
title: "Grant bot owner, editor, and user permissions"
status: complete-with-external-verification
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
