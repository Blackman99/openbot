---
sequence: 38
id: MEM-02
title: "Promote group memory to Bot-private memory with explicit approval"
status: complete
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

- [x] The UI and REST API show the source, destination Bot, resulting visibility, and content before promotion is confirmed.
- [x] No group memory is promoted to Bot-private scope without an explicit authorized human confirmation event.
- [x] The promoted record retains the source group ID, source memory ID, approver, approval time, and its own version.
- [x] The destination Bot can use the promoted memory across its conversations and groups.
- [x] Every other Bot receives no result when listing, searching, or assembling context for the private memory.
- [x] A requester lacking access to the source group or edit permission on the destination Bot receives 403 and no record is created.

## Non-goals

- Bulk promotion
- Automatic cross-group propagation
- Sharing private memory through templates
- Workspace knowledge promotion

## Completion evidence

Closed on 2026-09-05 against product HEAD `78afd6a` with Verify [33979196352](https://github.com/Blackman99/openbot/actions/runs/33979196352) (16/16), including native `postgres-memories` and Compose.

1. Preview fields: REST/UI/Compose show source, destination Bot, `bot-private` visibility, and content before confirm; preview inserts no `bot_private_memories` row.
2. Explicit confirmation: `acknowledged !== true` is 400 with no private memory; unused non-expired intent plus `acknowledged: true` is required.
3. Lineage: promoted record keeps source group ID, source memory ID, approver, approval time, and version 1; confirmations are unique per intent.
4. Destination use: native dest-Bot claim in another group selects `bot_private_memories`; Compose dest search still returns the promoted id after a second group exists.
5. Isolation: other Bot list/search are empty; native other-Bot context writes zero `run_private_memory_references`.
6. Authorization: missing source-group access or destination-Bot edit is 403 with no intent or private memory.
