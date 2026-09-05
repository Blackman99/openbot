---
sequence: 23
id: COL-06
title: "Add deterministic group turn routing"
status: complete-with-external-verification
blocked_by:
  - COL-02
  - COL-04
labels:
  - area:collaboration
  - area:routing
  - type:feature
  - mvp
---

# COL-06 — Add deterministic group turn routing

## Outcome

Group messages select one eligible Lead by explicit mention, configured default, then local role and semantic matching, with every decision visible to users.

## Blocked by

- [COL-02](19-col-02-add-bot-membership-and-history-grants.md)
- [COL-04](21-col-04-execute-a-single-bot-task-end-to-end.md)

## Acceptance criteria

- [x] An explicit Bot mention overrides the configured default Lead and local matching.
- [x] Without a mention, the eligible configured default Lead is selected.
- [x] Without a mention or default, identical inputs produce the same local-match winner.
- [x] Routing issues no model-provider request.
- [x] Removed, disabled, unauthorized, and incompatible Bots are excluded.
- [x] The selected Lead, reason, and candidate evidence are stored and shown in the conversation.

## Non-goals

- Hidden LLM routing
- Multi-Bot voting
- Invoking every group Bot

## Accepted implementation and external evidence

Source `9be9f17baba8cde4ec801b32ab091e36520f64fc` is integrated in reviewed source `0ff6898eee671f04987fd5024a0bbc3c2d0afef4`, tree `3173dfcb6ea9af4913c0eae5fea67748a623dce2`; the accepted evidence commit is `0fd1198e2c0dc1c43dc3e8f59742e4e58ab99f72`. Component and combined Spec/Standards reviews are CLEAN. The dedicated merger ran one complete `pnpm verify` with exit 0: 1,453 nonbrowser tests, 53 ordinary browser journeys, one OIDC journey, formatting, zero-error/zero-warning Web types and both production builds. See [combined evidence](../STREAM-BATCH-VERIFICATION.md).

`COL-06-E1` remains an explicit [REL-01 release gate](67-rel-01-mvp-release-acceptance-and-distribution.md): execute seven routing PostgreSQL cases within the actual Task suite and deployed migration 0021/default-routing privileges. Local skips and syntax checks do not satisfy native PostgreSQL or Compose evidence. The original acceptance texts are unchanged.
