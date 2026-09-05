# Conversation ledger handoff

Recommended implementation defaults for COL-03 and its COL-02 consumer. This is a design handoff; implementation waits for the recorded ticket prerequisites.

## Ownership and ordering

- COL-03 owns the single conversation ledger and sequence allocator. COL-02 consumes that committed foundation for join/removal events and history grants. Record the discovered COL-02 dependency on COL-03 rather than introducing temporary timestamps, counters or a second history table.
- There is one conversation per group and one private direct conversation per `(workspace, Bot, human creator)`. Canonical UUIDs and unique subject constraints make get-or-create deterministic.
- Keep immutable conversation subject/creator fields, a mutable `last_sequence`, and append-only conversation events. Initially derive current message projections from events rather than maintaining another mutable content authority.
- Allocate each sequence by updating the locked conversation row within the append transaction. Never use unlocked `MAX(sequence)+1`; order by sequence, not timestamp or UUID. Event identity includes conversation and sequence, a stable event ID, logical message ID, type/schema version and server-assigned authorship/time.
- Lock workspace, group when present, Bot when needed, then conversation; recheck current authority after waiting. Extract narrow transaction-owned group/Bot admission rather than reusing authorization snapshots from another transaction.

## Current permissions

- A direct thread is private to its human creator, intersected with current workspace membership and Bot permission. History requires inspect permission; writes require use. Bot ownership or workspace/group administration never grants access to another person's direct thread. Provider availability does not block authorized historical reads.
- Group messages require current workspace and explicit group access. Authors may edit their own human messages. Group owners/admins may moderate through a justified tombstone, without rewriting another author's content. Bot outputs are not human-editable. No undelete default.
- Full version-chain reads require current message-author or group owner/admin authority; direct chains require the direct creator. Ordinary readers receive current projections without deleted bodies or prior revisions. Guessed IDs cannot escape current conversation/scope authorization.

## Writes, replay and projections

- Scope idempotency keys to authenticated principal and conversation. Fingerprint the typed operation, target, precondition and normalized payload. Reauthorize before replay. Same key/payload returns the original stable `{messageId, eventId, sequence}` receipt; another payload returns409. Check replay before version CAS.
- The first event can carry the command's unique key/hash, avoiding a separate receipt table initially. The counter, event, receipt and required mutation audit commit together; failure must not burn an idempotency key.
- Edits require the expected current version and append a complete version event. Deletion appends a tombstone. Original events remain unchanged. Public inputs cannot choose authors, timestamps, sequence numbers or arbitrary system-event types.
- Keyset pagination orders messages by creation sequence and fixes a creation-order horizon. Each page resolves the current authorized version/tombstone. An ordinary cursor must not freeze historical bodies and bypass audit-read restrictions. Cursor state survives service restarts without process memory.
- Current-state comparisons and response bodies expose only permitted message content/provenance. Audit metadata contains safe references and operation details, not duplicate message bodies or credentials.

## History grants and later consumers

- COL-02 atomically appends join/removal events and changes history grants using ledger positions. Future-only starts at the join boundary; since-event/time resolves once to a conversation-local sequence. Removal closes the grant. A new grant never silently unions previous grants or exposes the absence interval.
- Apply history eligibility to the message's original creation event before projecting allowed versions. An edit after a Bot joins cannot expose a pre-grant message. Tombstones and current source permissions still apply.
- Preserve provenance references `{scope, conversationId, messageId, versionEventId}` for MEM-01/RET-01; recheck access, history bounds and tombstones before context projection/ranking.
- COL-04 later appends a triggering message and creates its Task/Run atomically. COL-05 reuses the same sequence namespace and defines its retention/resume policy; message-only sequences need not be contiguous. Neither execution nor SSE belongs in COL-03.

## Verification boundaries

Real PostgreSQL must prove duplicate-key collapse, payload-mismatch rejection, unique ordered writes, competing edit CAS, audit rollback, waiting-actor revocation and denied event UPDATE/DELETE/TRUNCATE. Runtime conversation UPDATE is limited to its counter column; historical events cannot disappear through cascading deletion. Local fixtures are not database-lock or privilege evidence.
