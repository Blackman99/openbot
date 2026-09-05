---
sequence: 12
id: BOT-01
title: "Create and inspect a persistent bot identity"
status: blocked
blocked_by:
  - PROV-05
labels:
  - bot
  - identity
  - vertical-slice
  - mvp
---

# BOT-01 — Create and inspect a persistent bot identity

## Outcome

Users can create bots with stable identities, immutable initial configurations, model bindings, and default execution limits, then inspect them from a list.

## Blocked by

- [PROV-05](11-prov-05-manage-capabilities-overrides-and-compatible-fallback-chains.md)

## Acceptance criteria

- [ ] The creation UI and API accept name, role, description, system instructions, model binding, and default token, duration, turn, and delegation-depth limits.
- [ ] Creation produces a stable bot ID, immutable version 1, and current-version pointer, with the creator as sole bot owner.
- [ ] Users can bind only enabled models they may use; inaccessible or invalid models return actionable validation errors.
- [ ] A Basic model may be bound, but list and detail views label the bot chat-only and unsuitable for reliable delegation.
- [ ] List and detail endpoints enforce workspace and bot visibility boundaries without leaking guessed cross-workspace IDs.
- [ ] API integration and Playwright tests cover field limits, model access, default limits, and the creation audit event.

## Non-goals

- Conversation, task, or delegation execution
- Bot memory or routines
- A public template marketplace
