---
sequence: 19
id: COL-02
title: "Add Bot membership and history grants"
status: complete-with-external-verification
blocked_by:
  - COL-01
  - BOT-04
  - COL-03
labels:
  - area:collaboration
  - area:groups
  - area:permissions
  - type:feature
  - mvp
---

# COL-02 — Add Bot membership and history grants

## Outcome

Authorized users can add or remove Bots with auditable future-only, since, or all-history access without gaining implicit Bot edit rights.

## Blocked by

- [COL-01](18-col-01-add-group-lifecycle-and-human-membership.md)
- [BOT-04](15-bot-04-grant-bot-owner-editor-and-user-permissions.md)
- [COL-03](20-col-03-store-conversations-in-an-immutable-event-ledger.md)

## Acceptance criteria

- [x] Inviting a Bot without a history option creates a future-only grant at the join event.
- [x] Inviters can choose future-only, since a selected event or time, or all history.
- [x] Bot context excludes every event below the active grant's lower bound.
- [x] Removing a Bot closes its grant and blocks access to all later events.
- [x] Reinviting a Bot creates a new grant and does not expose the removal interval unless explicitly authorized.
- [x] The default ninth active Bot is rejected with a machine-readable limit error.
- [x] Group Admins without Bot Editor permission cannot change the Bot's identity or configuration.

## Non-goals

- Cross-group memory sharing
- Bot ownership and ACL changes
- Unlimited Bot membership

## Discovered implementation dependency

COL-02 joins, removals and history boundaries consume the single COL-03 ledger/sequence allocator. The explicit COL-03 prerequisite avoids provisional timestamps, duplicate counters and unreviewed ledger fragments. It introduces no cycle and changes no acceptance criterion; ticket sequence identifiers stay stable. Follow [the ledger contract](../CONVERSATION-LEDGER-CONTRACT.md).

## Ready implementation handoff

COL-03 is integrated with its explicit REL-01 database evidence gate; other prerequisites are fully complete. Follow [GROUP-BOT-HANDOFF](../GROUP-BOT-HANDOFF.md), the ledger contract and BOT-CONTRACT for permanent grant closure, typed membership events and history projection.


## Implementation and verification

All seven criteria are implemented and locally verified on `ticket/col-02`. API core `9163b5037aab7b701c7589ce26ceae1fae0d7d32`; final source/test candidate `3a297f9a94e33aaf5830a1cb17a77d6edee103ad` (production unchanged after `efe3eb76705d69e9b47fb9e2fd8cfbfaaa864fd7`). The immutable membership events share the COL-03 ledger/counter; migration 0015 adds retained history grants and PostgreSQL guards. Bot ACL/workspace revocation closes grants durably in the same transaction without granting content access.

Local gates: **809 unit/integration tests**, types, formatting, production builds, **23 ordinary + 1 signed OIDC browser scenarios**. Both independent Standards and Spec reviews are clean at the final source pin. Browser fixtures are UI evidence; the API/client suite separately crosses real Fastify HTTP and persistence.

**COL-02-E1 remains pending actual PostgreSQL/Compose CI**: 14 dedicated native cases register but skip locally because no PostgreSQL service is available. The dedicated job covers actual runtime grants, concurrent caps/duplicates, both revocation orderings, event/audit rollback, retained history and current admission. This does not count as native execution success. Root owns integration/publication and external gate closure.

See [API and transaction contract](../COL-02-API-CONTRACT.md) and [full verification evidence](../COL-02-VERIFICATION.md). Ticket is ready for the dedicated integration review/merge; no root/global metadata or remote branch was changed by the author.

## Integrated acceptance

Accepted merge `28ce290e994f769219eb16b17565eb589dc12e16` passed the complete `pnpm verify`: 867 unit/integration tests (API88+302, Web52+425), 26 ordinary browser journeys and one signed OIDC journey, formatting, zero-error/zero-warning types and both builds. Both independent reviews are CLEAN at final source3a297f9; author finalaa08422 only records evidence. Root independently reviewed four additive shared integration paths;34 other paths exactly match the candidate. No behavior fixes were needed. The14 native cases and migration0015/Compose are explicit COL-02-E1 gates in REL-01; dependent local implementation is now unlocked.
