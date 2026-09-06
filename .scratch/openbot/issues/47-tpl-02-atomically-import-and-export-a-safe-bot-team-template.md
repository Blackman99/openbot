---
sequence: 47
id: TPL-02
title: "Atomically import and export a safe Bot-team template"
status: complete
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

- [x] The team export contains Bot templates, group roles, default Lead selection, collaboration limits, and default budgets but no real users, secrets, histories, memories, or file bodies.
- [x] Before import, the UI lists every object to be created and requires an explicit compatible model mapping for each Bot.
- [x] Import cannot start while any required model mapping, permission acknowledgement, or validation result is unresolved.
- [x] Failure while creating any Bot, membership, or group configuration rolls back the entire import and leaves no partial team objects.
- [x] Any Routine definition included by a later compatible schema version is imported disabled and cannot run until explicitly enabled by an authorized owner.
- [x] A cross-Workspace import creates detached copies and grants no access path to the source Workspace, attachments, or knowledge content.

## Non-goals

- Public template discovery
- Automatic Routine activation
- Copying human memberships
- Cross-instance live references

## Implementation note

Export uses schema `openbot.team-template.v1` (and compatible `openbot.team-template.v1.routines`). The document carries Bot templates, group roles, default Lead key, collaboration cap, and default budgets. Users, secrets, histories, memories, file bodies, and live IDs are omitted and rejected. Preview lists every object to create. Import requires a compatible model mapping per Bot and the required acknowledgements. Create writes the group, Bots, memberships, routing, and later-schema routines in one transaction; later-schema routines stay disabled under a CHECK constraint. Cross-Workspace import creates detached copies with no source identifiers. These notes do not change the original acceptance texts.

## Completion evidence

Closed on 2026-09-06 against product HEAD `ecb8ab1` with Tester PASS on [Verify 34010936156](https://github.com/Blackman99/openbot/actions/runs/34010936156) (all 20 jobs green).

1. Live group export includes Bot templates, roles, default Lead, collaboration limits, and budgets, and omits users, secrets, histories, memories, file bodies, and live IDs.
2. The import UI lists every object to create and requires an explicit compatible model mapping for each Bot.
3. Preview and create stay unresolved until every mapping, acknowledgement, and validation result is present.
4. `postgres-auth` ran `rolls back every Bot, membership and group row when a later membership cannot be created` against PostgreSQL; the integration suite rejects an oversized membership import.
5. Later-schema routines import disabled; `group_imported_routines` rejects `enabled=true`.
6. A cross-Workspace import creates a new private group and Bots with no source Workspace, group, or Bot identifier.
