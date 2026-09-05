---
sequence: 39
id: MEM-03
title: "Extract and review candidate memories from completed runs"
status: complete
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

- [x] A completed run enqueues candidate extraction and stores candidates with source event IDs, confidence, proposed scope, and pending status.
- [x] Pending and rejected candidates never appear in memory search or model context.
- [x] An authorized reviewer can edit a pending candidate and approve it into an explicitly selected permitted scope.
- [x] Cross-Bot, cross-group, or Workspace-scope approval requires a separate explicit confirmation step.
- [x] Rejecting a candidate records the decision and prevents later automatic approval of that candidate.
- [x] Retrying extraction for the same run and normalized candidate does not create a duplicate candidate.

## Non-goals

- Unreviewed autonomous memory writes
- External extraction services
- Memory scoring or decay
- Scheduled memory cleanup

## Discovered implementation dependencies

Real Bot-scope approval reuses MEM-02 private-memory storage, current-lineage admission and its bound confirmation writer. Candidate extraction still owns its durable job, exact Run input manifest, edited facts and group/Workspace scope. See [frontier handoff](../EXECUTION-FRONTIER-HANDOFF.md). These are implementation prerequisites for the approved criteria, not new criteria. All 67 tickets and 401 original acceptance texts remain unchanged.

## Completion evidence

Closed on 2026-09-05 against product HEAD `9f25a7c` with Verify [33984665506](https://github.com/Blackman99/openbot/actions/runs/33984665506) (all jobs green). Tester stamped 6/6 original ACs PASS.

1. Enqueue and pending store: completed Runs persist a body-free source manifest and one extraction job; `local-marked-lines-v1` writes pending candidates with source event IDs, confidence, proposed scope, and pending status.
2. Inert until approval: pending and rejected candidates are excluded from memory search and model context; only approved facts are selectable.
3. Edit and scoped approve: an authorized reviewer can edit a pending candidate and approve it into an explicitly selected permitted scope.
4. Cross-scope confirmation: cross-Bot, cross-group, or Workspace-scope approval requires a separate unused preview intent plus explicit acknowledgement.
5. Rejection: rejecting a candidate records the decision and blocks later automatic approval of that candidate.
6. Dedup: retrying extraction for the same Run and normalized candidate does not create a duplicate candidate.
