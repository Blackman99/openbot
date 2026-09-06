---
sequence: 50
id: API-03
title: "Manage groups and membership through the public API"
status: ready-for-agent
blocked_by:
  - API-01
  - COL-02
  - COL-03
  - COL-06
  - COL-13
labels:
  - area:api
  - area:collaboration
  - kind:feature
  - priority:mvp
---

# API-03 — Manage groups and membership through the public API

## Outcome

External clients can manage groups, human and bot members, default leads, history grants, and group concurrency limits.

## Blocked by

- [API-01](48-api-01-scoped-api-token-lifecycle.md)
- [COL-02](19-col-02-add-bot-membership-and-history-grants.md)
- [COL-03](20-col-03-store-conversations-in-an-immutable-event-ledger.md)
- [COL-06](23-col-06-add-deterministic-group-turn-routing.md)
- [COL-13](30-col-13-enforce-atomic-run-concurrency-limits.md)

## Acceptance criteria

- [ ] An authorized token can create groups, update names and policies, retrieve details, and archive groups.
- [ ] An authorized token can add or remove humans and bots, set the default lead, and set the concurrency limit.
- [ ] A bot invitation accepts future, since, or all history access and defaults to future when omitted.
- [ ] A token without group-management permission receives 403 when changing membership, with no membership mutation.
- [ ] A removed member immediately loses access to future content while prior messages and audit records remain.
- [ ] Groups and memberships created through the API match the web UI in end-to-end tests.

## Non-goals

- Public guest groups
- Cross-instance federated groups
- Automatic external-user discovery or invitation

## Discovered implementation dependencies

Default-Lead policy consumes COL-06 routing, and group concurrency policy consumes COL-13 scheduling. These prerequisites let the public API expose enforced domain behavior. API-03 still owns its group archive vertical slice. The dependency graph remains acyclic with67 tickets and401 unchanged acceptance criteria. See [public API handoff](../PUBLIC-API-HANDOFF.md).
