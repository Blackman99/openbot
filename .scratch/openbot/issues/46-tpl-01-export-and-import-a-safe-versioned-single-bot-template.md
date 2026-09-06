---
sequence: 46
id: TPL-01
title: "Export and import a safe versioned single-Bot template"
status: complete
blocked_by:
  - BOT-03
  - BOT-04
  - MEM-02
  - PROV-05
labels:
  - feature
  - area:templates
  - area:security
  - mvp
---

# TPL-01 — Export and import a safe versioned single-Bot template

## Outcome

An authorized user can download a reviewable Bot template and import it as an independent Bot only after inspecting its behavior and rebinding it to a compatible model connection.

## Blocked by

- [BOT-03](14-bot-03-edit-compare-and-restore-bot-versions.md)
- [BOT-04](15-bot-04-grant-bot-owner-editor-and-user-permissions.md)
- [MEM-02](38-mem-02-promote-group-memory-to-bot-private-memory-with-explicit-approval.md)
- [PROV-05](11-prov-05-manage-capabilities-overrides-and-compatible-fallback-chains.md)

## Acceptance criteria

- [x] The versioned JSON export contains Bot identity, full instructions, capability requirements, collaboration policy, and default budgets.
- [x] The export contains no API key, secret header, connection ID, conversation history, private memory, attachment body, or stored object reference.
- [x] Import validation rejects unsupported schema versions, unknown security-sensitive fields, malformed values, and unmet required capabilities with field-level errors.
- [x] Before creation, the UI displays the complete instructions, requested capabilities, permissions, budgets, and differences from any selected local Bot.
- [x] Creation remains disabled until the importer explicitly binds a connection and model satisfying the declared required capabilities.
- [x] A successful import creates an independent Bot with no mutable reference or read path back to the exported Bot or source Workspace.

## Non-goals

- Secret detection inside arbitrary user-authored prompt prose
- Private memory export
- Public template marketplace
- Live synchronization with the source Bot

## Discovered implementation dependencies

Export uses schema `openbot.bot-template.v1` with identity, instructions, required capability, declared collaboration visibility, and budgets. Connection IDs, API keys, secret headers, avatar/object references, history, and private memory are omitted and rejected on import. Preview can diff a selected local Bot. Creation requires an explicit local model binding that satisfies the declared capability. Imported Bots are new private owner-only records with no source Bot or Workspace identifier. These notes do not change the original acceptance texts.

## Completion evidence

Closed on 2026-09-05 against product HEAD `a7f4d31` with Verify [33989291158](https://github.com/Blackman99/openbot/actions/runs/33989291158) (all 16 jobs green).

1. Export includes identity, full instructions, required capability, collaboration policy, and default budgets.
2. Export and import walk reject API keys, secret headers, connection IDs, history, private memory, attachments, and object/source refs.
3. Import returns field-level `invalid_bot_template` errors for schema, forbidden fields, malformed values, and unmet capabilities.
4. The import UI previews instructions, capabilities, permissions, budgets, and optional local Bot diffs before create.
5. Create stays disabled until the importer binds a connection and model that satisfies the declared capability.
6. A successful import creates a new private owner-only Bot with no source Bot or Workspace identifier.
