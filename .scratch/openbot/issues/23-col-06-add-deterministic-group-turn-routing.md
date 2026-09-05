---
sequence: 23
id: COL-06
title: "Add deterministic group turn routing"
status: blocked
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

- [ ] An explicit Bot mention overrides the configured default Lead and local matching.
- [ ] Without a mention, the eligible configured default Lead is selected.
- [ ] Without a mention or default, identical inputs produce the same local-match winner.
- [ ] Routing issues no model-provider request.
- [ ] Removed, disabled, unauthorized, and incompatible Bots are excluded.
- [ ] The selected Lead, reason, and candidate evidence are stored and shown in the conversation.

## Non-goals

- Hidden LLM routing
- Multi-Bot voting
- Invoking every group Bot
