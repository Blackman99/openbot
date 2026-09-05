---
sequence: 49
id: API-02
title: "Manage bots through the public API"
status: blocked
blocked_by:
  - API-01
  - BOT-03
  - BOT-04
  - BOT-06
labels:
  - area:api
  - area:bots
  - kind:feature
  - priority:mvp
---

# API-02 — Manage bots through the public API

## Outcome

External clients can create, retrieve, paginate, update, inspect versions of, and archive authorized bots through /v1.

## Blocked by

- [API-01](48-api-01-scoped-api-token-lifecycle.md)
- [BOT-03](14-bot-03-edit-compare-and-restore-bot-versions.md)
- [BOT-04](15-bot-04-grant-bot-owner-editor-and-user-permissions.md)
- [BOT-06](17-bot-06-archive-restore-and-soft-delete-bots.md)

## Acceptance criteria

- [ ] A token with bots:read can retrieve and paginate visible bots but cannot modify them.
- [ ] A token with bots:write can create, update, and archive bots, with results immediately visible in the web UI.
- [ ] Bot changes made in the UI round-trip through the API without data loss.
- [ ] An update against a stale bot version returns 409 and does not overwrite newer configuration.
- [ ] Responses never expose connection secrets, private-memory content, or internal encryption fields.
- [ ] Bot endpoints, pagination, error envelopes, and permission responses have OpenAPI 3.1 contract tests.

## Non-goals

- Public template marketplace
- Sharing live bots across workspaces
- Reading model-connection secrets through the API

## Discovered implementation dependency

The archive acceptance criterion consumes BOT-06 lifecycle rules and UI. Adding BOT-06 prevents a second archive implementation; no acceptance criterion or ticket sequence changes. See [public API handoff](../PUBLIC-API-HANDOFF.md).
