---
sequence: 16
id: BOT-05
title: "Safely copy a bot configuration"
status: ready-for-agent
blocked_by:
  - BOT-03
  - BOT-04
labels:
  - bot
  - copy
  - security
  - vertical-slice
  - mvp
---

# BOT-05 — Safely copy a bot configuration

## Outcome

Authorized users can preview and copy the current configuration into a new private bot without copying credentials, ACLs, history, or memory.

## Blocked by

- [BOT-03](14-bot-03-edit-compare-and-restore-bot-versions.md)
- [BOT-04](15-bot-04-grant-bot-owner-editor-and-user-permissions.md)

## Acceptance criteria

- [ ] A member with bot user access or higher can open a preview that explicitly lists included and excluded fields.
- [ ] Confirming the copy creates a new stable bot ID and version 1, with the actor as sole owner.
- [ ] The copy includes only reviewable identity, instructions, execution limits, and permitted avatar references; it excludes ACLs, credentials, history, memory, file contents, and audits.
- [ ] If the actor cannot use the source model, confirmation requires selecting an accessible replacement model.
- [ ] Cancellation or validation failure creates no bot, version, ACL, or orphaned object.
- [ ] Automated tests scan responses and new records for connection keys or sensitive headers and verify the copy audit event.

## Non-goals

- Cross-workspace template import or export
- Copying conversation history or memory
- A public bot marketplace

## Implementation handoff

Follow [BOT-COPY-LIFECYCLE-HANDOFF](../BOT-COPY-LIFECYCLE-HANDOFF.md). BOT-03 is integrated; its remaining native evidence stays explicit in REL-01.
