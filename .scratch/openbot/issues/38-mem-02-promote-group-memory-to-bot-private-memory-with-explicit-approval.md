---
sequence: 38
id: MEM-02
title: "Promote group memory to Bot-private memory with explicit approval"
status: ready-for-agent
blocked_by:
  - MEM-01
labels:
  - feature
  - area:memory
  - area:authorization
  - mvp
---

# MEM-02 — Promote group memory to Bot-private memory with explicit approval

## Outcome

An authorized human can preview and explicitly promote a group memory into one Bot's private memory while preserving lineage and preventing access by every other Bot.

## Blocked by

- [MEM-01](37-mem-01-save-a-group-message-as-scoped-memory-and-use-it-in-the-next-answ.md)

## Acceptance criteria

- [ ] The UI and REST API show the source, destination Bot, resulting visibility, and content before promotion is confirmed.
- [ ] No group memory is promoted to Bot-private scope without an explicit authorized human confirmation event.
- [ ] The promoted record retains the source group ID, source memory ID, approver, approval time, and its own version.
- [ ] The destination Bot can use the promoted memory across its conversations and groups.
- [ ] Every other Bot receives no result when listing, searching, or assembling context for the private memory.
- [ ] A requester lacking access to the source group or edit permission on the destination Bot receives 403 and no record is created.

## Non-goals

- Bulk promotion
- Automatic cross-group propagation
- Sharing private memory through templates
- Workspace knowledge promotion
