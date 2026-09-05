---
sequence: 27
id: COL-10
title: "Add bounded retries and explicit model fallback"
status: blocked
blocked_by:
  - COL-09
  - PROV-05
labels:
  - area:collaboration
  - area:runs
  - area:providers
  - type:feature
  - mvp
---

# COL-10 — Add bounded retries and explicit model fallback

## Outcome

Transient failures receive bounded retries before an explicit, capability-compatible fallback, with every change visible in the audit and UI.

## Blocked by

- [COL-09](26-col-09-retry-failed-tasks-with-immutable-attempts.md)
- [PROV-05](11-prov-05-manage-capabilities-overrides-and-compatible-fallback-chains.md)

## Acceptance criteria

- [ ] Only transient errors are retried; authentication and validation errors are not.
- [ ] Automatic retries stop at the configured attempt limit.
- [ ] After retry exhaustion, only a Bot-configured fallback with required capabilities is eligible.
- [ ] Each fallback event shows the previous and next provider and model and the reason.
- [ ] Without an eligible fallback, the Task fails without duplicate Tasks or user messages.

## Non-goals

- Silent provider substitution
- Global unconfigured fallbacks
- Cost-based model brokering
