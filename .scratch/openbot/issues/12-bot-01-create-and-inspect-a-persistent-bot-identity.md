---
sequence: 12
id: BOT-01
title: "Create and inspect a persistent bot identity"
status: complete-with-external-verification
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

- [x] The creation UI and API accept name, role, description, system instructions, model binding, and default token, duration, turn, and delegation-depth limits.
- [x] Creation produces a stable bot ID, immutable version 1, and current-version pointer, with the creator as sole bot owner.
- [x] Users can bind only enabled models they may use; inaccessible or invalid models return actionable validation errors.
- [x] A Basic model may be bound, but list and detail views label the bot chat-only and unsuitable for reliable delegation.
- [x] List and detail endpoints enforce workspace and bot visibility boundaries without leaking guessed cross-workspace IDs.
- [x] API integration and Playwright tests cover field limits, model access, default limits, and the creation audit event.

## Non-goals

- Conversation, task, or delegation execution
- Bot memory or routines
- A public template marketplace

## Implementation and verification

Implemented all six acceptance criteria using [BOT-CONTRACT](../BOT-CONTRACT.md). The UI/API creates a private stable Bot with immutable version 1, sole creator ownership, current-version pointer and mandatory transactional audit. Workspace membership intersects independent Bot permissions, while workspace-visible discovery exposes metadata only. Model admission checks current usage rights, enabled state, selected model identity and Basic capability inside the creation transaction. Viewer-specific status remains fresh after provider disable, model changes, capability changes and loss of access; version configuration is never rewritten or silently rebound.

Both independent STANDARDS and SPEC reviews are clean on final code candidate `cdeff01f87a0c4aaa9a102afaa6c9e576b7b7e24`. The combined local gate passed 594 tests (77 API unit, 217 API integration, 30 Web unit, 270 Web integration), 15 ordinary browser journeys, one real signed-OIDC journey, repository formatting, both typechecks with zero warnings/errors, and both production builds. All six verification commands ran in sequence and returned exit code 0. Browser ports were verified closed afterward.

## External verification exception — BOT-01-E1

The eight native PostgreSQL cases are written and locally discovered but skipped because `TEST_BOT_DATABASE_URL` is unavailable. They must run in the isolated `postgres-bots` CI job against the actual restricted runtime role before this evidence gate closes. They cover native deferred same-Bot pointer enforcement, immutable version mutations, exact runtime grants, atomic audit rollback, current admission and both orderings of provider disable/workspace removal, plus creation time sampled after the admission lock.

Migration `0012_bot_identity` follows published0011. The existing Compose gate now asserts the ordered ledger and exact Bot table/column privileges; no extra upstream model probe fixture is required. Local pg-mem and browser fixture success does not prove these native constraints or grants. Root owns BOT-01-E1 closure, publication and global index/PROGRESS/REL integration metadata.

See [BOT-01-VERIFICATION.md](../BOT-01-VERIFICATION.md) for exact evidence and future transaction seams, and [BOT-01-API-CONTRACT.md](../BOT-01-API-CONTRACT.md) for safe DTOs, field bounds and error contracts.
