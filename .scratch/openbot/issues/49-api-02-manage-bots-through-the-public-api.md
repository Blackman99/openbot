---
sequence: 49
id: API-02
title: "Manage bots through the public API"
status: complete-with-external-verification
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

- [x] A token with bots:read can retrieve and paginate visible bots but cannot modify them.
- [x] A token with bots:write can create, update, and archive bots, with results immediately visible in the web UI.
- [x] Bot changes made in the UI round-trip through the API without data loss.
- [x] An update against a stale bot version returns 409 and does not overwrite newer configuration.
- [x] Responses never expose connection secrets, private-memory content, or internal encryption fields.
- [x] Bot endpoints, pagination, error envelopes, and permission responses have OpenAPI 3.1 contract tests.

## Non-goals

- Public template marketplace
- Sharing live bots across workspaces
- Reading model-connection secrets through the API

## Discovered implementation dependency

The archive acceptance criterion consumes BOT-06 lifecycle rules and UI. Adding BOT-06 prevents a second archive implementation; no acceptance criterion or ticket sequence changes. See [public API handoff](../PUBLIC-API-HANDOFF.md).

## Accepted implementation and external gate

All six functional criteria are implemented and independently reviewed at source `18ad24f06dd8a5afe2b795462975d186a0650487`. Dedicated merge `bdaa32526383739243a227a7c5023a4c8b3e7ffd`, tree `b2a174630bef5616d6a8dc7140adf349d50f6fde`, preserves accepted Task, attachment, copy and lifecycle behavior. Both source review axes, all seven shared integration paths and the subsequent fixture reset correction are independently CLEAN.

The accepted local composite gate passed 1,075 unit/integration tests (API 99 + 372, Web 65 + 539), 37 ordinary browser journeys, one signed OIDC journey, formatting, zero-error/zero-warning types and final builds. The public Bot journey uses real Fastify/domain services, migrated pg-mem, private avatar storage and the Svelte UI; it passed within the final ordinary suite. The initial `pnpm verify` exited 1 because a public fixture remained active for a later status scenario. The reviewed fixture-only reset correction then passed the unchanged targeted three-case regression and complete ordinary/OIDC suites plus final builds. This is a composite gate, not one full `pnpm verify` exit 0.

API-02-E1 remains explicit in REL-01: all 31 registered public-Bot PostgreSQL cases require actual execution under the deployed restricted role. Locally all 31 were skipped, with zero native cases executed. Verify33959031255 predates API-02 and supplies no API-02 native evidence. See [integration evidence](../API-02-INTEGRATION.md), [author acceptance evidence](../API-02-EVIDENCE.md), [native coverage](../API-02-NATIVE-EVIDENCE.md) and [API contract](../API-02-CONTRACT.md).
