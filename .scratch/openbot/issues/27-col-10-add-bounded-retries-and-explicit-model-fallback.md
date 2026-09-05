---
sequence: 27
id: COL-10
title: "Add bounded retries and explicit model fallback"
status: complete
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

- [x] Only transient errors are retried; authentication and validation errors are not.
- [x] Automatic retries stop at the configured attempt limit.
- [x] After retry exhaustion, only a Bot-configured fallback with required capabilities is eligible.
- [x] Each fallback event shows the previous and next provider and model and the reason.
- [x] Without an eligible fallback, the Task fails without duplicate Tasks or user messages.

## Non-goals

- Silent provider substitution
- Global unconfigured fallbacks
- Cost-based model brokering


## Completion evidence

Closed on 2026-09-05 against HEAD `f6b3f24` with Tester stamps and Verify `33976310825` (16/16).

1. Transient-only: `model-failure-taxonomy` + `adapter-next-attempt` (401/validation schedule none).
2. Attempt limit: `retry-schedule` / `next-attempt` stop at per-model and chain ceilings.
3. Configured fallback only: listed-binding claims under runtime PG; unlisted/exhausted never selected.
4. Previous/next/reason: Task/stream DTOs + BFF/browser exact locators (Verify green).
5. No eligible fallback: same Task fails; no duplicate Task/trigger; Compose restart-before-due for waiting interval.
