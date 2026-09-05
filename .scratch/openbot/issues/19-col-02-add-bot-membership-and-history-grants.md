---
sequence: 19
id: COL-02
title: "Add Bot membership and history grants"
status: blocked
blocked_by:
  - COL-01
  - BOT-04
labels:
  - area:collaboration
  - area:groups
  - area:permissions
  - type:feature
  - mvp
---

# COL-02 — Add Bot membership and history grants

## Outcome

Authorized users can add or remove Bots with auditable future-only, since, or all-history access without gaining implicit Bot edit rights.

## Blocked by

- [COL-01](18-col-01-add-group-lifecycle-and-human-membership.md)
- [BOT-04](15-bot-04-grant-bot-owner-editor-and-user-permissions.md)

## Acceptance criteria

- [ ] Inviting a Bot without a history option creates a future-only grant at the join event.
- [ ] Inviters can choose future-only, since a selected event or time, or all history.
- [ ] Bot context excludes every event below the active grant's lower bound.
- [ ] Removing a Bot closes its grant and blocks access to all later events.
- [ ] Reinviting a Bot creates a new grant and does not expose the removal interval unless explicitly authorized.
- [ ] The default ninth active Bot is rejected with a machine-readable limit error.
- [ ] Group Admins without Bot Editor permission cannot change the Bot's identity or configuration.

## Non-goals

- Cross-group memory sharing
- Bot ownership and ACL changes
- Unlimited Bot membership
