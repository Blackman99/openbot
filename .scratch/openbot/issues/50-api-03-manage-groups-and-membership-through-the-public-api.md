---
sequence: 50
id: API-03
title: "Manage groups and membership through the public API"
status: complete
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

- [x] An authorized token can create groups, update names and policies, retrieve details, and archive groups.
- [x] An authorized token can add or remove humans and bots, set the default lead, and set the concurrency limit.
- [x] A bot invitation accepts future, since, or all history access and defaults to future when omitted.
- [x] A token without group-management permission receives 403 when changing membership, with no membership mutation.
- [x] A removed member immediately loses access to future content while prior messages and audit records remain.
- [x] Groups and memberships created through the API match the web UI in end-to-end tests.

## Non-goals

- Public guest groups
- Cross-instance federated groups
- Automatic external-user discovery or invitation

## Discovered implementation dependencies

Default-Lead policy consumes COL-06 routing, and group concurrency policy consumes COL-13 scheduling. These prerequisites let the public API expose enforced domain behavior. API-03 still owns its group archive vertical slice. The dependency graph remains acyclic with67 tickets and401 unchanged acceptance criteria. See [public API handoff](../PUBLIC-API-HANDOFF.md).

## Implementation note

Authorized `groups:read` and `groups:write` tokens manage groups on `/v1` with the same admission model as API-02. Migration `0049_group_archive` adds `archived_at` and `max_concurrent_runs`. Session Group JSON is unchanged; the public DTO adds `archivedAt`, `policy.maxConcurrentRuns`, and `defaultLead`. History access is `future`, `since`, or `all`, and defaults to `future`. Archive is idempotent and rejects further management writes. These notes do not change the original acceptance texts.

## Completion evidence

Closed on 2026-09-06 against product `dc05dba` with Tester PASS on [Verify 34017551070](https://github.com/Blackman99/openbot/actions/runs/34017551070) at `f3ba1fa` (all 20 jobs green). Later claim-tool typecheck follow-ups on that HEAD do not change public group routes.

1. `creates, updates, retrieves, and archives groups through groups:write` creates a group with name, description, and `maxConcurrentRuns`, PATCHes name/visibility/concurrency, GETs the public DTO, and archives with `archivedAt` set. A later PATCH returns 409 `group_archived`.
2. `adds and removes humans and bots, defaults history to future, and sets the default lead` adds a human member, invites a bot without history (mode `future-only`), invites another with `historyAccess: all`, and PATCHes routing to that grant.
3. The omitted-history invite in that test is `future-only`. Explicit `all` is accepted. `since` is covered by group-bot history parsing (`future`, `since`, or `all`).
4. `rejects membership changes without group-management permission and leaves membership unchanged` returns 403 `insufficient_scope` without `groups:write` and 403 `group_forbidden` for a non-manager, with the member list unchanged.
5. After DELETE, the member is absent from the session member list and receives 403 on the group. Prior conversation events and audit rows remain.
6. `round-trips a public group and membership through the real UI` creates the group via `/v1`, shows the heading in the web UI, adds a member through the public API, and shows that member after reload.
