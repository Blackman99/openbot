---
sequence: 20
id: COL-03
title: "Store conversations in an immutable event ledger"
status: complete-with-external-verification
blocked_by:
  - COL-01
  - BOT-01
labels:
  - area:collaboration
  - area:conversations
  - area:data
  - type:feature
  - mvp
  - implementation-complete
---

# COL-03 — Store conversations in an immutable event ledger

## Outcome

Group and direct-Bot conversations support idempotent writes, stable ordering, versioned edits, tombstones, cursor reads, and current-state projections.

## Blocked by

- [COL-01](18-col-01-add-group-lifecycle-and-human-membership.md)
- [BOT-01](12-bot-01-create-and-inspect-a-persistent-bot-identity.md)

## Acceptance criteria

- [x] Repeated writes with the same idempotency key create one logical message.
- [x] Concurrent writes receive unique, monotonically ordered conversation sequence numbers.
- [x] Editing a message appends a version event without mutating the original event.
- [x] Deleting a message appends a tombstone without deleting or mutating the original event.
- [x] Default reads return the current projection; authorized audit reads return the full version chain.
- [x] Cursor pagination preserves ordering and projections across service restarts.

## Non-goals

- Memory extraction and knowledge promotion
- Full-text and vector retrieval
- Real-time event delivery

## Implementation contract

Follow [CONVERSATION-LEDGER-CONTRACT](../CONVERSATION-LEDGER-CONTRACT.md) for direct-thread privacy, current permissions, idempotency/CAS, creation-horizon pagination with current projections, and the shared transaction-owned sequence allocator. COL-02 is an explicit downstream consumer; no temporary second ledger is needed.

## Implementation and verification

All six acceptance criteria are implemented through persistent API/domain/storage and complete Web flows. Both independent Standards and Spec reviews are clean at source `e599f4ca96474a47c59dfe140bb9e29f2b7547fa`, based on `47553b1e5331aeaa869d44e96537b38d53d9fd2b`. The Standards mutable-metadata finding is closed: borrowed admission retains private frozen canonical authority, and exposed metadata cannot redirect its SQL or audit scope.

Full local verification passed645 unit/integration tests (API77+232, Web35+301), formatting, both typechecks with zero Svelte errors/warnings, both production builds,18 ordinary browser scenarios and one signed OIDC journey. The browser fixture is a UI seam; real Fastify/client HTTP tests separately exercise the actual API. Final reviewers independently passed62 Standards and51 Spec focused cases; neither claimed native/browser reruns.

External gate **COL-03-E1** remains open for actual PostgreSQL and Compose execution on the integrated revision. The10 native cases are defined but skipped locally because no database URL is available; these skips do not prove concurrent ordering, rollback, immutable triggers or runtime privileges. Migration0014, exact narrow runtime grants and the dedicated CI job carry those assertions. Root owns integration and gate closure.

The borrowed same-transaction API exposes typed append/edit/tombstone with durable replay receipts. Its allocator remains private. COL-02 will add a migration and typed membership event append that reuses this counter/admission/audit, while COL-04 can append a trigger beside dependent Task/Run writes in the caller's transaction. This ticket implements no Task/Run execution, SSE, history grants, memory or retrieval.

See [COL-03-VERIFICATION](../COL-03-VERIFICATION.md) for red/green evidence, review pins and integration notes, and [COL-03-API-CONTRACT](../COL-03-API-CONTRACT.md) for the exact API/DTO and transaction seam.

## Accepted integration

COL-03 integrated as `d559da23b4ae19429304f3a124f93f187025df42`, tree `26dc19629b52d56076128aeb7b64538a7fb6c396`. Both independent review axes are CLEAN at source `e599f4ca96474a47c59dfe140bb9e29f2b7547fa`; final author `3a3511e342978dfe9f607d33a77062202e6fd7e7` adds only evidence. Dedicated integrated full `pnpm verify` exited0:755 unit/integration tests (API88unit+275integration, Web40unit+352integration),21 ordinary browsers and one signed-OIDC journey,formatting/types/builds. Root independently reviewed the seven-file additive integration delta; conversation core/source tests match the reviewed candidate exactly. YAML/36 Bash steps/two embedded JS/three MJS syntax checks passed. Native PostgreSQL ten cases and actual Compose remain the explicit COL-03-E1 release gate.
