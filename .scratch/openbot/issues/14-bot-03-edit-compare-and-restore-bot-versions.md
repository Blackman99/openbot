---
sequence: 14
id: BOT-03
title: "Edit, compare, and restore bot versions"
status: ready-for-agent
blocked_by:
  - BOT-01
  - BOT-02
labels:
  - bot
  - versioning
  - vertical-slice
  - mvp
---

# BOT-03 — Edit, compare, and restore bot versions

## Outcome

Every bot configuration change creates an immutable version, and authorized users can inspect differences and restore prior configurations through a new version.

## Blocked by

- [BOT-01](12-bot-01-create-and-inspect-a-persistent-bot-identity.md)
- [BOT-02](13-bot-02-upload-and-securely-display-bot-avatars.md)

## Acceptance criteria

- [ ] Editing configuration or avatar references atomically creates a new version and advances the current pointer without overwriting prior records.
- [ ] Updates require a current version or ETag; stale concurrent writes return HTTP 409 without losing committed versions.
- [ ] The version view lists author, time, and rationale and shows field-level differences for identity, instructions, model, avatar, and limits.
- [ ] Restoring a prior version creates a new current version without deleting, renumbering, or modifying history.
- [ ] Editing or restoring a model binding revalidates the user's access to the target connection and model.
- [ ] Integration and Playwright tests cover version creation, conflicts, and restoration, with an audit event for every successful change.

## Non-goals

- Editing chat-history or memory versions
- Git-style branching or merging
- Copying versions across workspaces
