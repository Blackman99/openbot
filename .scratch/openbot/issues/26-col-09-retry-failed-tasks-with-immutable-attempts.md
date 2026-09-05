---
sequence: 26
id: COL-09
title: "Retry failed Tasks with immutable attempts"
status: ready-for-agent
blocked_by:
  - COL-04
labels:
  - area:collaboration
  - area:runs
  - type:feature
  - mvp
---

# COL-09 — Retry failed Tasks with immutable attempts

## Outcome

Authorized users can retry failed Tasks while preserving failed Runs and preventing duplicate attempts.

## Blocked by

- [COL-04](21-col-04-execute-a-single-bot-task-end-to-end.md)

## Acceptance criteria

- [ ] Retrying a failed Task creates one queued Run with the next attempt number.
- [ ] Repeated retry commands with one idempotency key create no additional Run.
- [ ] Completed and running Tasks reject retry with a machine-readable state error.
- [ ] The original failure, provider, model, output, and timestamps remain immutable and auditable.
- [ ] A successful retry creates one current answer projection while preserving earlier attempts.

## Non-goals

- Automatic transient retries
- Automatic model fallback
- Arbitrary historical-state replay
