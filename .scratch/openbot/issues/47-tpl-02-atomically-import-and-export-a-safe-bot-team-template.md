---
sequence: 47
id: TPL-02
title: "Atomically import and export a safe Bot-team template"
status: in-progress
blocked_by:
  - TPL-01
  - COL-02
  - COL-12
labels:
  - feature
  - area:templates
  - area:collaboration
  - mvp
---

# TPL-02 — Atomically import and export a safe Bot-team template

## Outcome

A complete group configuration with multiple safe Bot templates can be reviewed, rebound, and imported atomically without carrying users, secrets, history, or live links across Workspaces.

## Blocked by

- [TPL-01](46-tpl-01-export-and-import-a-safe-versioned-single-bot-template.md)
- [COL-02](19-col-02-add-bot-membership-and-history-grants.md)
- [COL-12](29-col-12-enforce-hierarchical-execution-limits.md)

## Acceptance criteria

- [ ] The team export contains Bot templates, group roles, default Lead selection, collaboration limits, and default budgets but no real users, secrets, histories, memories, or file bodies.
- [ ] Before import, the UI lists every object to be created and requires an explicit compatible model mapping for each Bot.
- [ ] Import cannot start while any required model mapping, permission acknowledgement, or validation result is unresolved.
- [ ] Failure while creating any Bot, membership, or group configuration rolls back the entire import and leaves no partial team objects.
- [ ] Any Routine definition included by a later compatible schema version is imported disabled and cannot run until explicitly enabled by an authorized owner.
- [ ] A cross-Workspace import creates detached copies and grants no access path to the source Workspace, attachments, or knowledge content.

## Non-goals

- Public template discovery
- Automatic Routine activation
- Copying human memberships
- Cross-instance live references

## Implementation note

First TDD slice parses and exports `openbot.team-template.v1` with Bot templates, group roles, default Lead key, collaboration cap, and default budgets. Users, secrets, histories, memories, file bodies, and live IDs are rejected. Original acceptance texts stay unchecked.
