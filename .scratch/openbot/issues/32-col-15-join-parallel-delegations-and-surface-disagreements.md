---
sequence: 32
id: COL-15
title: "Join parallel delegations and surface disagreements"
status: in-progress
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

- [ ] Child Tasks run concurrently only within effective Task and Group limits.
- [ ] Excess children remain queued instead of being dropped or exceeding the limit.
- [ ] The parent resumes exactly once after all children reach terminal states.
- [ ] Child results reach the Lead in stable order with Bot and Task attribution.
- [ ] Failed children and partial results remain visible and are not presented as consensus.
- [ ] A conflicting-results test preserves both sources and instructs the Lead to state the disagreement.

## Non-goals

- Majority voting
- Unlimited recursive delegation
- Cross-group delegation

## Implementation note

A schema-valid Lead generation may emit multiple `delegate` actions. Migration `0043_task_parallel_delegations` lets one parent Run record many children. The parent parks once, stays `waiting_child` until every child is terminal, then creates exactly one `child_result` Lead Run. Joined results keep Bot and Task attribution in created-at order. Conflicting or incomplete children stay visible and instruct the Lead to state the disagreement instead of presenting consensus. Excess children remain queued behind COL-13 concurrency holds. Original acceptance texts stay unchecked.
