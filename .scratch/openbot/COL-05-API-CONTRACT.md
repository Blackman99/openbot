# COL-05 private conversation stream contract

Root approved the original five ticket22 ACs and the copied `COL-05-APPROVED-HANDOFF.md`. Implementation worktree `ticket/col-05` starts at accepted COL-04 `cb9977374ff2b3d40ebb9b5783647d99c32cfcb1`. COL-04-E1's native assertion diagnosis remains separate. Migration0019 is reserved by root but must wait for the root-declared accepted ATT-01 baseline0018. No0017 rewrite or predecessor placeholder.

## Private HTTP seam

Accepted ATT-01 merge `0bbaf8562fc2727cc5c563f1f3a1555cdd910779` is incorporated. Actual migration0019 now follows its0018; this does not close ATT-01's external native/S3/Compose evidence limits.

- `GET /api/v1/workspaces/:workspaceId/conversations/:conversationId/events/bootstrap`: current session only, no query/body. Returns a bounded JSON snapshot and a high-water cursor from one current conversation-inspection transaction.
- `GET /api/v1/workspaces/:workspaceId/conversations/:conversationId/events`: current session only. Requires exactly one valid `Last-Event-ID` header and no query/body; fresh clients bootstrap first. Authorized resume returns `text/event-stream; charset=utf-8`, private/no-store/no-transform, nosniff. A missing cursor is400 `invalid_stream_cursor`, with no silent jump to the tail.
- Same-origin BFF routes use the same suffixes under `/app/workspaces/:workspaceId/conversations/:conversationId`. They forward only their authenticated session and validated cursor to the fixed internal API. They stream incrementally and cancel upstream when the browser disconnects. They never cancel a Task, retry generation, route work or submit a replacement Task.
- Stable JSON errors are `{error:{code}}`: actual missing/expired session401 `authentication_required`; current conversation denial403 `conversation_forbidden`; malformed/future/cross-scope cursor400 `invalid_stream_cursor`; retained prefix unavailable410 `cursor_expired`; unexpected unavailable503 `conversation_stream_unavailable`. Authenticate and authorize before exposing cursor/floor details. Only an actual401 response may clear session identity.
- After headers, content-free `stream.control` with `{schemaVersion:1,code}` may signal `authentication_required`, `conversation_forbidden`, `cursor_expired`, `slow_consumer` or `conversation_stream_unavailable`, then close. Controls/heartbeat comments have no id and never advance acknowledgement. If backpressure prevents even a control frame, close the socket.

## Cursor and framing

The version1 cursor is canonical base64url JSON with exactly `{v:1,workspaceId,conversationId,after}`. UUIDs are canonical lower-case. `after` is a safe integer from0 through9007199254740991. Encoded cursors are at most512 characters, bind both resource IDs, and are not credentials. A reconnect resumes strictly after its last applied cursor. After below retention floor is410, after equal to floor is valid, after above current tail is400. A wrong-resource cursor never changes the selected workspace/conversation.

Every durable SSE frame has `id: <cursor>`, `event: <type>` and one JSON data envelope:

`{schemaVersion:1,cursor,conversationId,sequence,occurredAt,type,data}`

`cursor.after` equals `sequence`; occurredAt is an ISO timestamp. Cursor workspace/conversation match the authorized request. Event-specific payloads are exact allowlists. The complete encoded frame is at most256KiB. UTF-8 is decoded incrementally, CR/LF splits and multiline data are supported, comments do not dispatch, and incomplete/oversized/malformed frames cannot advance acknowledgement.

### Durable event payloads

| Type | Exact data |
| --- | --- |
| `message.changed` | `{message: MessageReference}` using the current permitted source revision/tombstone at delivery |
| `task.run.updated` | `{execution: ExecutionState}` with Task/Run statuses from one committed transition |
| `assistant.delta` | `{taskId,runId,attempt,startByte,endByte,text}`; UTF-8 text byte offsets, nonempty text, each normalized delta at most4KiB |
| `conversation.invalidated` | `{reason:'membership'}` for typed ledger membership events; advances the same cursor without exposing grant internals |

`MessageReference` is exactly `{messageId,creationSequence,versionEventId,sequence,deleted,taskId,runId}`; the last two are both null for a human message and canonical retained IDs for a Bot output. It names the **current** authorized revision or tombstone, never a captured historical body. The UI resolves it through the existing current-message locator under fresh BFF/API authorization, validates same message and a revision at least as new as the reference, applies the current projection, then acknowledges the stream event. This keeps attachment/current-source projection in its owning module and prevents stream replay from resurrecting old text or attachment metadata. Deleted references clear any cached body immediately. A final Bot reference removes its Run preview and upserts the stable ledger messageId exactly once.

`ExecutionState` is exactly `{taskId,runId,attempt,taskStatus,runStatus,bot,executionUser,createdAt,startedAt,finishedAt,provider,usage,error,output}`. Task/Run statuses are equal and one of queued/running/completed/failed; only attempt1 is created here. Bot is `{id,displayName,versionId,versionNumber}`, executionUser is `{id,displayName}`. Provider is null or `{protocol,modelId}`. Usage is null or nonnegative safe `{inputTokens,outputTokens}`. Error is null or an existing COL-04 safe TaskFailure. Output is null or the existing `{messageId,eventId,sequence}` receipt. Queued/running/terminal nullability follows COL-04. No configuration, secret headers, endpoint values, credentials, raw provider errors or claim tokens.

## Atomic bootstrap and bounded state

Bootstrap returns exactly `{schemaVersion:1,cursor,conversationId,messages,nextMessageCursor,executions,nextTaskCursor,previews,previewsTruncated}`. All members and high-water cursorH are selected under one current inspection transaction. Messages contain at most20 current MessageReferences in normal creation order and retain ordinary message pagination. Executions contain at most20 safe ExecutionStates and retain ordinary Task pagination. Previews are `{taskId,runId,attempt,endByte,text}`, always a complete retained prefix from byte0; omit a preview whose prefix was reclaimed. Return at most8 previews and at most256KiB total preview text. The complete serialized bootstrap is at most1MiB; stop selection before that aggregate bound and set previewsTruncated when any active preview is unavailable/omitted. Active preview records and processing also have bounded count/byte budgets. Never concatenate unbounded retained rows before checking limits.

The BFF/browser can resolve bounded message references to current projections using the existing locator; no endpoint reruns a Task to recover text. SnapshotH prevents the page/stream boundary from silently skipping an in-flight transition. Browser acknowledgement advances only after valid decoding and applying the corresponding state/reference resolution. Permanent messages remain keyed by messageId, previews by runId and byte offset. Dropped connection, duplicate terminal frame, reload and410 recovery converge to one final ledger answer. Failed runs never create one from preview text.

## Durable writes and worker ordering

All delivery events share `conversations.last_sequence`; immutable ledger writes mirror a delivery reference at their existing sequence. Typed delta/status appends use the same private allocator and cannot expose a generic arbitrary eventwriter. Message delivery references and audit rows do not copy historical message bodies; the existing immutable source ledger retains its own version history. Existing required domain audits stay atomic with their states and delivery records.

Order: trigger before queued; committed running before provider call; first nonempty callback delta immediately committed before the provider completes; subsequent deltas may coalesce for at most25ms or4KiB with at most8KiB pending. Flush the single ordered publication chain before terminal admission. Terminal response.events rebuild only the pure accumulator/validator and cannot publish callback text again. Await the full generate promise; a complete callback plus final error still has no ledger answer. Success atomically publishes the one Bot ledger reference before completed state. Duplicate/stale claims publish nothing.

Use workspace → group where present → Bot where required → conversation → Task → Run → provider order. Before queue failure can append status, a private structural lock path derived only from the persisted Task acquires conversation before Task/Run even if current execution authorization fails. It grants no context/read bypass. Each delta/finish retains current claim/deadline/execution authority. Preserve MEM-01 insertion points after target admission, after successful claim CAS and after fresh finish admission; no memory source selector or prompt changes.

## Delivery, backpressure and retention

At open, resume and each delivery after idle/drain/lock waits, check current viewer session and current conversation inspection under resource locks. A successful open is not cached authority. A direct conversation stays creator-private; group readers need current human group rights, not the old Task grant or provider credentials. Enqueue only a bounded currently authorized frame; never await socket drain while holding locks. Bytes already enqueued while authorized cannot be recalled; after revocation wins, no new content is enqueued. Backpressure must cause reauthorization, not delivery from a stale authorized batch.

BFF and API each stop read-ahead when downstream cannot accept data, cap queued bytes at512KiB, and disconnect after10s stalled drain. Poll/reauthorize at most1s while idle; send data-free heartbeat every15s. Connect/error reads are bounded separately. Abort navigation/disconnect cancels reader, upstream request and polling only.

The authorized API open emits an immediate data-free comment; the BFF replaces complete upstream activity with its own heartbeat to flush the Node response before a provider has emitted text. Partial frames do not become heartbeat acknowledgements. Browser rendering caches at most100 current messages, each with the existing32,000-character/128,000-byte maximum, while the reducer retains at most1000 message references and64 Run markers. The complete20-reference bootstrap page therefore fits without dropping earlier sources. Bootstrap's own nextMessageCursor drives the next page, so its20-reference limit cannot skip the gap to the ordinary30-message page. Historical/targeted message pages retain ordinary pagination without starting a live stream.

Delta publication samples the persisted deadline again after progress and retention writes. Final publication samples it after the mandatory completed audit and delivery write. If the latter check fails, roll back the attempted Bot output, audit, completed state and sequence, then re-admit and fail the same claim with execution_timeout in a new transaction; no new Run or provider request is created. A permanent source purge may change the current deleted marker without changing its immutable versionEventId; the client accepts that monotonic deletion and forbids resurrection.

Retention default is24h or10,000 events/16MiB per conversation, whichever needs the earlier cutoff. Enforce append-time hard limits and bounded periodic cleanup for idle conversations. Reclaim only a contiguous stream prefix and advance its durable floor in the same transaction. Retention metadata has a separate row/table because the existing conversation UPDATE guard only allows a single sequence increment. Do not delete immutable ledger, Task/Run or audit records. Native guards prevent UPDATE/TRUNCATE and invalid prefix deletion. New migration initializes the delivery floor to each existing conversation tail; matching API/worker code begins delivery afterward.

410 is a fixed recovery path: stop, clear transient previews, obtain a fresh authorized bounded bootstrap and resume after its H. Preserve ledger identities and never resubmit old work. API-06 may reuse codec/floor/backpressure primitives later; this ticket does not add /v1/events or pretend conversation-local counters define a workspace-global order.

## Verification ownership

Write and witness tests before implementation. Required evidence includes aggregate bootstrap/active-preview bounds; actual delayed delta before final through the real BFF; restart/reconnect after acknowledged and partially read frames; fresh revoked permissions after waits/drain; one final ledger answer after replay; prefix-floor cleanup races; current-source message/attachment references; restricted-role native privileges, rollback and real blocked lock order; separate worker/API + actual proxy Compose delivery. Missing database/Compose/browser capability is recorded as open, not a native pass. Root retains port leases, both independent review axes, dedicated merge, progress and publication.

## Approved missing-preview and failed-locator behavior

If bootstrap deliberately omits an active prefix because of count, byte or retention bounds, a later valid delta may startByte>0. Mark that Run's preview explicitly unavailable/awaiting-final, advance its valid event acknowledgement, and continue to its final ledger locator. Never fabricate the prefix, duplicate text, resubmit the Task or enter a bootstrap/reconnect loop. The same rule covers a new delta for a Run outside the bounded bootstrap execution page. A targeted current-message locator403/401 after a scope/session change terminates consumption and reauthorizes; it does not repeatedly fetch the unacknowledged reference forever. Test >8 active executions with omitted/expired prefixes, later deltas and final output, plus a revoked locator.

Migration0019 installs deferred prefix validation on conversation tail updates as well as delivery/state changes. Every tail allocation must commit its matching delivery entry, including typed human, attachment, Bot output and group-Bot join/removal writers; a legacy writer that omits delivery must roll back. Restricted runtime permissions are sufficient for this check and still forbid delivery updates/truncation. Deployment verification restarts API/Web and exercises the same independently running Worker against the upgraded schema.
