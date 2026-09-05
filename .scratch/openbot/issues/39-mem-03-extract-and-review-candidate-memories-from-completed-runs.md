---
sequence: 39
id: MEM-03
title: "Extract and review candidate memories from completed runs"
status: ready-for-agent
blocked_by:
  - MEM-01
  - COL-04
  - MEM-02
labels:
  - feature
  - area:memory
  - area:runs
  - mvp
---

# MEM-03 — Extract and review candidate memories from completed runs

## Outcome

Completed runs can produce deduplicated candidate memories that remain inert until an authorized human edits, approves, or rejects them in a review inbox.

## Blocked by

- [MEM-01](37-mem-01-save-a-group-message-as-scoped-memory-and-use-it-in-the-next-answ.md)
- [COL-04](21-col-04-execute-a-single-bot-task-end-to-end.md)
- [MEM-02](38-mem-02-promote-group-memory-to-bot-private-memory-with-explicit-approval.md)

## Acceptance criteria

- [ ] A completed run enqueues candidate extraction and stores candidates with source event IDs, confidence, proposed scope, and pending status.
- [ ] Pending and rejected candidates never appear in memory search or model context.
- [ ] An authorized reviewer can edit a pending candidate and approve it into an explicitly selected permitted scope.
- [ ] Cross-Bot, cross-group, or Workspace-scope approval requires a separate explicit confirmation step.
- [ ] Rejecting a candidate records the decision and prevents later automatic approval of that candidate.
- [ ] Retrying extraction for the same run and normalized candidate does not create a duplicate candidate.

## Non-goals

- Unreviewed autonomous memory writes
- External extraction services
- Memory scoring or decay
- Scheduled memory cleanup

## Discovered implementation dependencies

Real Bot-scope approval reuses MEM-02 private-memory storage, current-lineage admission and its bound confirmation writer. Candidate extraction still owns its durable job, exact Run input manifest, edited facts and group/Workspace scope. See [frontier handoff](../EXECUTION-FRONTIER-HANDOFF.md). These are implementation prerequisites for the approved criteria, not new criteria. All 67 tickets and 401 original acceptance texts remain unchanged.
