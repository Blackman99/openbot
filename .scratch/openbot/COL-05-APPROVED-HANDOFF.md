# COL-05 read-only handoff and test-plan candidate

Root approved this design with the original five ACs unchanged. Implementation starts from accepted COL-04 cb9977374ff2b3d40ebb9b5783647d99c32cfcb1. ATT-01 owns0018; root reserved0019 for COL-05 only after the accepted ATT baseline is incorporated. This copied source handoff records the earlier read-only inspection, not current implementation verification.

Inspected source: `/workspace/scratch/2bc98607b3a9/openbot/.worktrees/col-04-ui`, frozen `35057913970a68717482cd3cabd90f37e7a879aa`. No repository file, ticket status, service or database was changed. No tests were executed for this planning task. No PostgreSQL, Docker or browser process was started.

## Goal and boundaries

Ticket22/COL-05 requires: (AC1) an assistant delta before Run completion; (AC2) Last-Event-ID resumes strictly after acknowledgement without missing or repeated application; (AC3) current conversation read permission at open/resume; (AC4) exactly one final ledger answer; (AC5) deltas and Task/Run state share one ordered durable cursor. Root additionally requires delivery-time authorization, private BFF streaming, bounded backpressure/cancellation, bounded retention and explicit expired cursors reusable by API-06.

Keep COL-04 execution rules: actual triggering human, pinned Bot version/exact group grant, existing provider rights, one attempt, current claim fencing, complete generation promise before success and one immutable final Bot message. Do not add routing, retry, user cancellation, recovery, approval, budget business rules, WebSockets or an external event bus. Closing a browser subscription cancels transport only; it must not cancel its Task or worker generation.

## Source pointers and findings

All paths below are relative to the inspected worktree; line numbers refer to the frozen source.

| Source | Relevant fact |
| --- | --- |
| `.scratch/openbot/issues/22-col-05-stream-authorized-conversation-events-over-sse.md` | Five AC and no permanent storage of superseded rendering deltas. |
| `.scratch/openbot/EXECUTION-CONTRACT.md`, `CONVERSATION-LEDGER-CONTRACT.md`, `COL-04-API-CONTRACT.md` | Existing execution authority, single private allocator, current projection and claim/finish contracts. The ledger handoff explicitly reserves the same sequence namespace for COL-05 and allows message-only sequences to have gaps. |
| `apps/api/src/conversations/append-event.ts:29` | Private append allocates `conversations.last_sequence+1` and inserts an event and mandatory audit in one caller-owned transaction. No exported free-standing allocation primitive. |
| `apps/api/src/conversations/schema.ts:11`, `:38` | Safe-integer BIGINT sequence; append-only event guards; every conversation UPDATE must advance last_sequence by exactly one. Retention metadata should not be added as an independently updated field on this row without a new guard design. |
| `apps/api/src/conversations/postgres-repository.ts:107` | `ConversationTransaction.lock(...,'inspect')` checks immutable scope, direct creator privacy, current workspace/group/Bot inspection, then locks conversation. Never substitute execution authority for the viewing human's authority. |
| `apps/api/src/conversations/projection.ts:65` | Current/tombstone projection excludes old deleted bodies; Bot message authors are immutable and have no human edit/delete/audit controls. |
| `apps/api/src/tasks/service.ts:228` | Submission reauthorizes, checks replay, then atomically appends one trigger, Task/queued Run and audit. Add queued delivery here without creating another trigger or replay event. |
| `apps/api/src/tasks/queue.ts:137`, `:249` | Claim and finish own durable transitions; finish appends one Bot result before completing Task/Run and audit. Failure branches at155 and270 may lock Task/Run after authorization failed before a conversation lock was obtained. New delivery writes must fix that ordering locally. |
| `apps/api/src/tasks/worker.ts:41`, `:91` | `observe` handles callback events, then is invoked again after clearing accumulators to rebuild from terminal response.events. Publishing from this same function would duplicate every delta. |
| `apps/api/src/providers/model-request.ts:66` | Production adapters await each asynchronous onEvent consumer; the terminal ModelResponse also retains those events. A complete callback is not the final success decision. |
| `apps/api/src/providers/sse.ts:1` | Existing provider SSE decoder handles CR/LF and multiline data but drops id/retry and has no per-frame bound. It is not yet a resumable client codec. |
| `apps/api/src/tasks/schema.ts:39`, `:52`, `:63` | Unique Run output identity plus immutable claim and terminal-state guards already enforce one final Bot message. Keep those0017 statements unchanged. |
| `infra/postgres/grant-runtime-privileges.mjs:193` | Runtime conversation UPDATE currently grants only last_sequence. Add precise new-table privileges and retention protections through an additive migration/provisioner update. |
| `apps/web/src/lib/server/task-api.ts:28` | Existing JSON BFF buffers a complete bounded body and applies a finite deadline; use its abort/error discipline, not its complete-body buffering for SSE. |
| `apps/web/src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/+page.svelte:42` | Permanent messages are already keyed by message.id. Preserve that identity when reconciling previews and final output. |
| `.scratch/openbot/issues/53-api-06-resumable-permission-scoped-sse-event-stream.md` | Future API-06 needs explicit cursor_expired, current auth, bounded slow-consumer disconnect and data-free heartbeats. It does not authorize adding /v1/events now. |

## Recommended durable design

Use **one conversation sequence and one retained delivery feed**, with the immutable ledger continuing to own permanent message content. Proposed names are implementation candidates, not allocated schema:

- `conversation_stream_events`: `(conversation_id, sequence)` primary key; typed event kind/schema version; immutable safe envelope; ledger_event_id or retained Task/Run reference; bounded delta payload; occurred_at and payload_bytes. Restrict references to their actual conversation. Disallow UPDATE/TRUNCATE and arbitrary payload/event types. The stream table is durable until its retention prefix is reclaimed, not a process-local broadcast log.
- `conversation_stream_retention`: one row per conversation with monotone `floor_sequence` and bounded accounting. This avoids retention-only UPDATEs against the existing conversation counter guard. Initialize an existing conversation's floor to its current last_sequence on migration; no COL-05 cursors existed before that floor. Bootstrap reads existing current ledger/Task state instead of inventing historical Task transitions.
- The existing private append implementation gains a private allocation helper reachable only through typed append methods. Existing message/membership/final-Bot writes insert a delivery reference using **the same allocated sequence** in the same transaction; never allocate a second sequence for a mirrored ledger event. New typed Task/Run and delta appends allocate that same counter and insert their retained stream event. Every allocation has a corresponding typed event; existing required domain audits remain atomic. Delta bodies are not duplicated into permanent ledger or audit rows. Document this deliberate extension of the allocator comment/contract.
- Message-only ledger positions may now have gaps; group history boundaries and pagination continue comparing original creation sequences, never assuming adjacency. The complete conversation stream advances through every committed allocation after its initial floor.
- PostgreSQL row locking on conversation orders allocations and commits across API/worker processes. Do not use timestamp ordering, MAX+1, UUID order, an in-memory counter or independent delta/status counters. Use the current safe-integer bound and reject overflow before publication.
- Readers query retained rows in ascending sequence. A local wakeup is optional; bounded database polling is sufficient and remains the source of truth. A dropped wakeup or API restart cannot lose committed events.

Proposed durable event family:

| Kind | Safe payload and ordering |
| --- | --- |
| `message.changed` | Ledger receipt/reference; project its **current authorized message/tombstone at delivery**, not a captured old message body. Final Bot output uses this same family with retained run/task provenance. Human revisions and Bot membership events must advance the cursor through safe typed projections or explicit content-free invalidations. |
| `task.run.updated` | One atomic safe Task/Run status snapshot/reference, including taskId, runId, attempt, both statuses, allowed timing/model/usage/error and output receipt. An envelope containing both statuses avoids briefly presenting an inconsistent Task/Run pair. No credentials, raw provider diagnostics or claim tokens. |
| `assistant.delta` | `{taskId,runId,attempt,startByte,endByte,text}`. Offsets use normalized UTF-8 text bytes, not provider chunk IDs or timestamps. The preview is not a ledger message. Derive all identities from the retained current claim. |

Submission transaction orders its trigger event before queued state. Claim transaction records running state before the model call. Successful finish transaction orders the one final ledger reference before completed state; failure commits only the safe failed state and no synthetic answer. All remaining buffered delta publications must finish before terminal admission. A stale/duplicate finish must append neither a ledger message nor another terminal event.

**Failure-path lock seam:** before adding state events to queue.fail, introduce a narrow internal lock operation derived from the persisted Task, acquiring workspace → group where present → Bot where required → conversation → Task → Run, even when execution permission has been revoked. It may finalize a denied current claim safely but must not expose context or grant a caller an authorization bypass. Fresh policy denial remains denial. Do not first lock Run and then update the conversation counter; provider scope remains last. Retain ordinary ConversationTransaction inspection for human readers.

## Callback and worker behavior

Split current observe into (a) a pure text/usage/budget accumulator and (b) a callback publication path. The callback path normalizes a text event, checks existing limits, and commits the first nonempty delta immediately. Subsequent chunks may be coalesced on a short bounded timer; keep a single ordered publication chain and a strict small byte buffer. The callback is awaitable, and transport already honors its backpressure. Publish only normalized text and safe execution references.

Before each delta commit, lock the retained Task's scope in the shared order, check current execution authority plus running claim token/deadline, and append atomically. Do not keep a database transaction open during provider network I/O. A failed/expired/stale admission cannot emit another delta; use existing failure/fencing behavior, with no automatic retry or new attempt. Preserve worker shutdown/deadline AbortSignals.

The terminal response rebuild invokes only the **pure** accumulator/validator. It cannot republish callback events. A provider that only supplies terminal text can finish normally but cannot satisfy the slow-stream AC test; that test must use a genuinely delayed callback. Await the complete generate promise and drain outstanding callback publications before queue.finish. A complete callback followed by an upstream error leaves only a failed transient preview and no final ledger answer. The canonical final response remains authoritative; do not construct a second answer from the preview.

## Cursor, bootstrap and authorization contract

Proposed API route: `GET /api/v1/workspaces/:workspaceId/conversations/:conversationId/events`; proposed same-origin BFF route: `/app/workspaces/:workspaceId/conversations/:conversationId/events`. The browser uses fetch with an explicit Last-Event-ID header, so it can distinguish HTTP errors and reconnect only after its reducer acknowledges an event. Do not put session/Bearer credentials in URLs. /v1/events and token support remain API-06.

Use a strict versioned opaque URL-safe cursor, at most512 characters, binding `{kind:'conversation',workspaceId,conversationId,after}`. Canonicalize IDs and require nonnegative safe integers. Stable SSE id encodes this cursor. Reject duplicate/malformed, wrong-conversation/workspace and future cursors; authorize before reporting resource/retention details. Never treat an ID as authorization. Resume selects `sequence > after` in original order; ack advances only after decoding, validating and applying the full event. A network write is not a client acknowledgement.

For no cursor or expired-cursor recovery, obtain a **bounded authorized bootstrap snapshot and high-water cursor H in one transaction**. Include current message page, relevant safe Task/Run state, bounded active previews if retained, and normal pagination/locators. Then subscribe after H. Implement that as a shared read service usable by SSR/resync and the stream's initial bootstrap; do not combine an old page snapshot with a later independently read tail. Ordinary old history stays available by existing page/locator routes. Active preview omitted due to retention must be marked unavailable, never reconstructed by rerunning the Task.

At open and every resume, authenticate the current session and call current conversation inspection for the actual viewer. Before each bounded event delivery/batch after any wait, recheck session validity and conversation permission on the resource connection after scope locks. Direct threads remain creator-private plus current Bot inspection; workspace/Bot administrators cannot inspect another creator's thread. Group readers need current human group content rights and do not need the Task's old grant or another user's provider credentials to read history.

Reauthorize after idle polling and after downstream backpressure. Never cache a successful open check for the stream lifetime. On lost authentication/authorization before headers, return the exact safe401/403; after headers, send only a content-free terminal control if writable and close, dropping undelivered application payloads. Permission checks linearize before enqueueing an event; bytes already enqueued while authorized cannot be recalled. No lock/transaction may remain held while waiting for a slow socket. Tests should assert no **new** content is enqueued after revocation wins the admission lock, including a pending blocked delivery.

## BFF, framing and bounded flow

Use `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: private, no-store, no-transform`, and nosniff. Do not set Content-Length or buffer the entire response. Verify behavior through the actual reverse-proxy path when implementation starts; do not assume headers alone disable an intermediary's buffering.

The BFF forwards only its authenticated session and the validated cursor to the fixed internal API route. It strips hop-by-hop/untrusted upstream headers, does not expose internal origins/tokens, and relays complete bounded frames on downstream demand. Bound initial response/error bodies separately from the long-lived stream. Replace the JSON client's whole-body deadline with a finite connect deadline, bounded idle/heartbeat timeout and abort propagation. Browser disconnect/navigation → BFF reader cancel/AbortController → upstream request/socket and polling cleanup; it never calls Task cancel or aborts worker generation.

Maintain at most one small frame plus a bounded transport queue. Await drain only outside resource transactions; discard/re-authorize pending content after any backpressure wait. Stop upstream read-ahead while downstream cannot accept data. For a consumer exceeding the bound/deadline, emit a content-free `slow_consumer` control when possible and close; if the socket cannot accept even that control, close without pretending an acknowledgement. The browser reconnects from its own last applied id and receives any unread retained rows.

A pure bounded Web codec can serve BFF and browser. Existing provider SseDecoder is useful reference but needs id handling, streaming UTF-8 decode, split CR/LF, multiline data, comments, complete blank-line dispatch, invalid/NUL IDs, per-line/frame byte bounds and truncation handling before reuse. Validate an explicit event union and canonical identities before advancing ack. Data-free heartbeat comments have no id and must not advance the cursor. Control events are not durable business events and cannot skip unread data.

Suggested bounded defaults to confirm in the implementation contract:25ms/4KiB delta coalescing after immediate first delta;8KiB pending delta buffer;64KiB maximum SSE frame;256KiB per-connection queued bytes;10s stalled-drain limit;15s heartbeat;1s maximum authorization/idle poll interval;24h or10,000 events/16MiB retained per conversation, whichever requires the earlier cutoff. These are proposed limits, not existing product promises. Keep aggregate bounds for a batch and all active previews as well as per-frame bounds.

## Retention and API-06 reuse

Cleanup removes only a contiguous prefix of delivery events, in the same transaction that advances that conversation's durable floor. Age/count/byte constraints must never create an interior hole. Enforce hard append-time bounds and bounded periodic cleanup for idle conversations. Never delete immutable conversation_events, Task/Run records, final messages or audit records to reclaim rendering deltas. Add exact new-table privileges/guards so accidental deletes cannot leave a valid cursor silently spanning missing entries; UPDATE/TRUNCATE remain denied.

Resume with after < floor returns explicit `410 {error:{code:'cursor_expired'}}`; after == floor is resumable. At an established stream, a lost retention race emits a content-free cursor_expired control and closes. The UI obtains a fresh authorized snapshot and reconciles permanent identities; it never silently jumps its acknowledgement to the current tail. This rule also applies if a slow consumer falls behind retention while connected.

Reuse the cursor codec envelope/versioning, scoped reader/retention-floor abstraction, safe errors, SSE framing, heartbeats and backpressure policy for API-06. Do not compare conversation-local sequence numbers from different conversations as a workspace-global order. API-06 will define its broader partition/aggregation cursor and current token admission without adding a second COL-05 text/status cursor.

## Client convergence

Keep transient previews keyed by runId and permanent messages keyed by ledger messageId. Apply each validated cursor once, merge text only at the expected byte offset, and deduplicate by stable id/offset rather than text equality. A final message reference/current projection replaces and removes its Run preview and upserts exactly one ledger message. Terminal state references the same output receipt; it must not append another answer. Replayed terminal events, SSR reload, reconnect and a separate current-state fetch converge to the same identity. Failure discards/labels incomplete preview and shows the existing safe error; it does not create a permanent message. Preserve message edit/tombstone and pagination semantics.

## Concrete test-first plan (not executed)

| Slice / AC | Failing witness to write first | Required passing evidence |
| --- | --- | --- |
| Slow callback / AC1 | Actual TaskWorker + real adapter against a delayed local provider; hold provider completion behind a test barrier. Open the stream before submission. | Browser/API receives first nonempty delta while persisted Run is running and the generation promise is still pending. Releasing the barrier yields the one final ledger answer. No sleeps used as proof of ordering. |
| One namespace / AC5 | Submit, claim, interleave human message/edit, emit several deltas and finish with concurrent writers. | Unique strictly ordered cursor for trigger, queued/running state, deltas, message/final and terminal state. Task/Run state and event rows/audits commit together. Existing group history ranges and message pages tolerate gaps. |
| Durable resume / AC2 | Stop after applying event N, disconnect before/within N+1, reconstruct the API reader/process and reconnect with Last-Event-ID N. | Only complete events >N are applied in original order; partial frames do not advance ack; duplicate last frame is ignored; commit-before-wakeup/restart still replays. Exercise splits at every frame and UTF-8 boundary. |
| Current rights / AC3 | Anonymous, wrong workspace/conversation, private-thread noncreator/admin, removed group member/direct Bot ACL; then revoke current session/workspace/group/direct Bot ACL during idle and blocked delivery. | Safe401/403 at open/resume and immediate denial at the next gated delivery. No new content after revocation wins; no cached snapshot authority after waiting; authorized group history does not re-admit an old execution grant/provider. |
| One final message / AC4 | Adapter invokes callbacks and returns the same terminal events; repeat finish/reconnect/reload. Also complete callback followed by response.error, expired/stale claim and worker stop. | Deltas published once only; unique bot_run_id/output_event_id and one ledger answer; final UI has one keyed message and no preview duplicate. Failure has no final ledger row. |
| BFF/codec | Real streaming body, delayed chunks, wrong content type, oversized frame/error, malformed ids/event payloads, stalled drain, navigation abort. | Incremental forwarding, bounded memory, strict decoding, cleanup/cancel propagation, no secret headers/URLs, no Task cancellation and correct resume after explicit slow-consumer closure. |
| Retention/API-06 seam | Contiguous prefix reclamation races a blocked reader; restart after cleanup; cursor just below/equal/above floor; byte and count caps; completed/failed previews expire. | Exact cursor_expired below floor, safe replay at floor, no interior gaps, bootstrap/tail atomicity, permanent message/Task/audit retention, no resubmission of old work. |

Proposed new focused suites: API `conversation-stream.test.ts` and `task-streaming.test.ts`; Web codec/reducer/BFF stream tests; browser `conversation-stream.spec.ts`; native `conversation-stream-runtime.test.ts`. Reuse existing `task-worker.test.ts`, `tasks-runtime.test.ts`, conversation/group-Bot native fixtures and Task/conversation browser journeys rather than duplicating their domain models.

Native PostgreSQL must execute with the deployed restricted role and real migrations/provisioner: concurrent allocator ordering; transaction/audit/event rollback; queued scope-revocation vs delivery/claim; failure-path lock ordering; retained claim/delta fencing; prefix cleanup/floor atomicity and exact new-table grants. Observe actual pg_stat_activity/pg_blocking_pids barriers. A separate worker/API process test must prove durable delivery rather than a shared in-memory emitter. Missing test URLs/discovery skips are not native evidence. Browser/proxy/PG/Docker use still needs root's later ownership/lease coordination.

## Suggested Skills

After root provides the accepted baseline and migration slot, use `matt-skills-curated:implement`, `matt-skills-curated:tdd` and `matt-skills-curated:implement-spec` for concrete contract-first vertical slices. Root retains separate `matt-skills-curated:code-review` Standards and Specification axes and dedicated merge. Use `matt-skills-curated:handoff` to keep the next resume note outside the repository. This document itself is read-only planning, not an implementation claim.

## Exact next action

Read this candidate:

```sh
cat /workspace/scratch/2bc98607b3a9/col-05-handoff-candidate-2026-09-05.md
```

Then wait for root's explicit accepted COL-04/ATT-01 baseline and migration assignment. Re-read the three pinned seams (allocator, queue failure lock path, callback/terminal reconstruction) at that baseline before creating any implementation worktree. Bring the proposed outbox/retention/authorization linearization and bounded defaults into the concrete COL-05 contract; do not change the ticket's blocked status, allocate a migration or begin production work based only on this candidate.
