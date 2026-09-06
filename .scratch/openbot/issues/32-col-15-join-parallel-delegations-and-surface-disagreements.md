---
sequence: 32
id: COL-15
title: "Join parallel delegations and surface disagreements"
status: complete
blocked_by:
  - COL-14
labels:
  - area:collaboration
  - area:delegation
  - area:scheduling
  - type:feature
  - mvp
---

# COL-15 — Join parallel delegations and surface disagreements

## Outcome

A Lead can run bounded child Tasks in parallel, join their attributed outcomes, and synthesize a response without hiding failures or disagreements.

## Blocked by

- [COL-14](31-col-14-delegate-a-bounded-child-task.md)

## Acceptance criteria

- [x] Child Tasks run concurrently only within effective Task and Group limits.
- [x] Excess children remain queued instead of being dropped or exceeding the limit.
- [x] The parent resumes exactly once after all children reach terminal states.
- [x] Child results reach the Lead in stable order with Bot and Task attribution.
- [x] Failed children and partial results remain visible and are not presented as consensus.
- [x] A conflicting-results test preserves both sources and instructs the Lead to state the disagreement.

## Non-goals

- Majority voting
- Unlimited recursive delegation
- Cross-group delegation

## Implementation note

A schema-valid Lead generation may emit multiple `delegate` actions. Migration `0043_task_parallel_delegations` lets one parent Run record many children. The parent parks once, stays `waiting_child` until every child is terminal, then creates exactly one `child_result` Lead Run. Joined results keep Bot and Task attribution in created-at order. Conflicting or incomplete children stay visible and instruct the Lead to state the disagreement instead of presenting consensus. Excess children remain queued behind COL-13 concurrency holds. These notes do not change the original acceptance texts.

## Completion evidence

Closed on 2026-09-06 against product HEAD `2921166` with Tester PASS on [Verify 34014775723](https://github.com/Blackman99/openbot/actions/runs/34014775723) (all 20 jobs green).

1. `keeps excess children queued inside the group concurrency cap` starts only the first sibling while the second stays queued under `maxConcurrentRuns: 1`.
2. The same case does not drop the excess child or exceed the group cap.
3. `joins conflicting children once and keeps both sources visible` parks the parent as `waiting_child` until both siblings terminate, then inserts exactly one `child_result` Lead Run.
4. `joins children in stable order and tells the Lead to state a disagreement` attributes each child by Bot and Task in created-at order.
5. Failed or incomplete children stay in the joined prompt and are not presented as consensus.
6. The conflicting-results case injects both bodies plus `State the disagreement; do not present them as consensus.`
