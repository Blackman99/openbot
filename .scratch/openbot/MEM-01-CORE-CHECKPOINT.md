# MEM-01 development dependency checkpoint

This is an implementation checkpoint for the actual schema dependency, not ticket acceptance. The original six MEM-01 acceptance criteria remain unchanged. Root owns final acceptance, independent Spec and Standards review, and integration after COL-05 acceptance.

This historical checkpoint is superseded for integration/verification status by [MEM-01-HANDOFF](MEM-01-HANDOFF.md) and [MEM-01-INTEGRATION-VERIFICATION](MEM-01-INTEGRATION-VERIFICATION.md), which record the complete COL-05 merge and exact final reviewed source tree. The original dependency and RED/GREEN observations below remain historical evidence.

## Actual predecessor chain

- Accepted ATT integration: `0bbaf8562fc2727cc5c563f1f3a1555cdd910779`, incorporated through `d2a5ddc`.
- Independent MEM source, API, UI and selector checkpoint: `e8cf3ad`.
- Actual COL-05 0019 development source: `6a8b9e88bf18a08363baff9afc2f631f6a40775c`, incorporated sequentially as `59a5e3c` with root authorization. Its native and independent acceptance remain pending.
- This checkpoint registers real `0020_group_source_memories` after real `0019_conversation_delivery`. It has no placeholder predecessors or rewrites of earlier migrations.

## Narrow shared contract

`conversations/message-source.ts` selects a current visible human or Bot text message, preserves its original creation sequence, and rejects tombstone or any pending/completed purge. Ordinary memory never grants historical-version access, even to the source author or an administrator.

`memories/schema.ts` owns immutable `group_memories`, `memory_versions` and `run_memory_references`. The first version references the exact source event and original creation event/sequence; no source body is copied into these tables. The creator, creation time, group scope and finite human confidence are server-projected. Guards enforce scope/source provenance, current exact Run authority, and append-only storage. Runtime grants permit SELECT/INSERT and no guard function execution.

`memories/run-context.ts` borrows the existing queue transaction and scope locks:

1. `selectRunMemoryContribution(connection, runId)` freshly admits the persisted Task human, Bot version and exact grant. It filters the source creation sequence by the grant lower bound and trigger horizon, then selects current sources. It returns one explicitly identified `group_memories` user contribution, exact UTF-8 bytes, item count and immutable locator references.
2. `persistRunMemoryReferences(connection, contribution)` runs only after the queue's successful running CAS. It checks current sources again and appends the exact version/event IDs selected for this claim.
3. `assertRunMemoryReferencesCurrent(connection, runId)` rechecks the persisted manifest before every streamed delta and terminal publication. It does not recompute or add newly saved memories. A changed source, purge, closed exact grant or lost current authority blocks subsequent publication.

The queue retains COL-05's single conversation stream allocator and typed transition writers. Memory adds no allocator, generic event writer or Task identity exception. A Run accepts at most 100 saved memories, with memory items and bytes included in the existing aggregate 1,000-item/1-MiB context budget. The trigger remains the final ordinary message. Bytes already legitimately sent to a provider or browser cannot be retroactively recalled.

REST and Web surfaces use current explicit group content membership. Read, list and body-query search optionally use an exact Bot grant. Search and pagination filter source eligibility and scope before LIMIT. A committed content-free denial audit is required for REST 403; audit failure produces 503. Creation uses expected source event plus a caller command key; replay never revives a stale memory.

## Evidence and outstanding gates

Witnessed RED before implementation: missing source selector (3 tests); REST routes returned 404 for expected 201/403; real worker lacked the identified memory block and published a stale answer after a source edit. The corresponding source/API and worker cases passed after implementation. A streaming overlap regression preserves the first legitimate delta and excludes subsequent stale deltas and final output.

At this checkpoint, 50 focused tests across ten API integration/input files passed with `--maxWorkers=4`, including the actual migration registry and COL-05 storage/worker regressions. API TypeScript and changed-file Prettier checks passed. Earlier focused Web component/client/page tests and Web TypeScript passed before the queue integration. The actual PostgreSQL privilege/guard/rollback/locking suite, Compose gate, browser acceptance, complete integrated non-browser gate, and both independent review axes are still required. No local PostgreSQL, Docker or browser service was provisioned for this checkpoint.

MEM-04 must intentionally extend immutable versions, forget/revoke and any explicit independently retained content. RET-01 may replace deterministic retrieval and budgets through the current scoped selector and exact sent-locator manifest; neither seam permits old source versions to re-enter ordinary reads or context.
