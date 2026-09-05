---
sequence: 15
id: BOT-04
title: "Grant bot owner, editor, and user permissions"
status: blocked
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

- [ ] A bot owner can grant or revoke owner, editor, and user access for members of the same workspace and set private or workspace-visible scope.
- [ ] Owners manage ACLs, edit, use, and delete; editors edit and use; users only inspect and use.
- [ ] Workspace administrators and future group administrators cannot edit, delete, or manage a bot unless its ACL grants access.
- [ ] Private bots are absent from unauthorized lists; workspace-visible bots expose only the configured discovery or use access.
- [ ] ACL revocation or workspace removal takes effect on the next bot API request, and the last bot owner cannot be removed.
- [ ] Two-user integration tests cover the full permission matrix, and every ACL or visibility change emits an audit event.

## Non-goals

- Group membership or group roles
- Public anonymous bots
- Cross-workspace ACLs
