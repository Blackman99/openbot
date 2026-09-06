# Task execution handoff

Recommended COL-04 defaults from read-only inspection of the existing model adapters, Bot permissions and conversation-ledger contract. COL-04 remains blocked until its recorded prerequisites are integrated. This handoff preserves later cancellation/recovery/concurrency seams without implementing those tickets early.

## Durable submission and execution identity

- Use a queued Run in PostgreSQL as the durable queue and a separate worker entry point. A process-local wakeup may reduce latency but cannot be the only record of pending work. The current application has no worker or Task/Run tables.
- The execution principal is the human who triggers the Task. The worker executes on that person's behalf; the Bot is the output author. Neither the Bot creator, inviter nor an administrator becomes an implicit credential proxy.
- A personal model connection remains usable only by its owner. Group Bot membership grants indirect invocation inside that group, not provider rights or direct Bot configuration access. Shared group Bots should use an accessible connection from the same workspace. A different person's personal binding yields a safe model-unavailable result.
- In one transaction, reauthorize the current actor, check the conversation-scoped idempotency replay, append the triggering human message, create the Task and attempt1 queued Run, and write mandatory safe audits. Pin the Bot version, execution principal, trigger event and exact group-grant identity where applicable. Replaying the original key/payload returns its original receipt, including after the Bot configuration changes.
- Consume the narrow borrowed-transaction conversation/Bot/group admission and append operations. A result obtained from another transaction is not authorization for this mutation.

## Claim, provider call and result

- Select a candidate Run ID before acquiring its row lock. Follow the shared order: workspace, group when present, Bot, conversation, Task/Run, then provider scope. Recheck current membership, direct or indirect Bot use, the exact active group grant, history eligibility and bound model before a queued-to-running CAS.
- Add a narrow internal execution-admission operation that reads current model revision and sealed credentials under the same provider scope lock. Keep the existing safe `admitUsableModel` DTO interface for ordinary API consumers. Adapters perform transport, not database authorization.
- Record a claim token, execution deadline and the connection/protocol/model/revision actually selected for this attempt. Commit the claim transaction before provider network I/O. Do not hold workspace or Bot locks during a model call.
- Pass an AbortSignal and explicit task-derived timeout/output budget to `ModelAdapter.generate`. Existing transport defaults are not the Task's limits. Usage may arrive as cumulative snapshots and must not be added repeatedly. Record the model actually sent; do not invent an upstream-reported model identifier when the adapter supplies none.
- Wait for the complete generation call and check its final error outcome. Receiving a complete callback alone is not permission to commit success. A failed call records a safe failure and does not fabricate a final assistant response from partial text.
- Finish in a short transaction that verifies current execution authority and the current running attempt/claim token. Append at most one final assistant message per Run and atomically commit its Task/Run status and mandatory audits. Stale or cancelled claims cannot publish a late result.
- Keep credentials, endpoint/header values and raw provider diagnostics out of Task/Run DTOs, ledger events and audits. Use persisted canonical IDs and the established personal/workspace secret-binding formats.

## Revocation and later tickets

- A queued group Task retains the exact grant used at submission. Removing and reinviting a Bot creates a new grant and cannot silently revive that queued Task. Direct conversations remain private to their creator with current direct Bot permission.
- If revocation commits before admission, do not start the call. Admission does not promise that an already-started network request can be undone; check authority again before publishing its result. The group grantor's continuing-authority policy is a COL-02 decision and must be explicit before that ticket implements it.
- COL-07 later supplies user cancellation and task-tree stopping. Preserve AbortSignal plus conditional claim/state transitions now.
- COL-11 later supplies leases, heartbeat and recovery using new attempts. Preserve stable Run identity and claim fencing now; do not automatically reclaim running work or claim exactly-once provider execution in COL-04.
- COL-13 later adds atomic workspace/group/task slots at the centralized claim/finish boundary. A process-local semaphore does not prove cross-worker concurrency limits.

## Accepted COL-02 integration details for COL-04

- GroupBotTransaction.lock(connection, {actorUserId,workspaceId,groupId,grantId}) now provides exact active-grant/context admission. It locks current human group access, current grantor direct Bot use, then the conversation. Its public content method is context(read), which returns permitted current human messages only. Extend a narrow internal transaction-owned execution-target method to obtain the pinned Bot/version configuration; do not duplicate authorization or require the triggering group member to hold direct Bot ACL. Provider credentials still require the actual triggering human's current provider rights.
- ConversationTransaction.lock currently discovers immutable subject then locks group and conversation. For group execution, perform grant/Bot admission before locking the conversation, preserving workspace→group→Bot→conversation→Task/Run→provider. Re-entering an already-owned lock in the same transaction is allowed; introducing a new earlier-scope lock after the conversation is not.
- Extend the private ledger allocator with a typed Bot-message append tied to a verified current Run claim, rather than inserting arbitrary events or granting a generic trusted bypass. Distinguish output Bot authorship from the human execution/audit principal. Existing human edit eligibility must explicitly reject Bot output even when executionUserId equals the viewer. Adapt strict projection/BFF/rendering for the author union and retained Bot version/identity marker, preserving historical human messages.
- In groups require the user to select one currently admitted group grant for this ticket; COL-06 owns default Lead/routing. Direct conversations already identify their Bot and remain creator-private. Keep task submission idempotent and atomic with its one human trigger event, Task and attempt1 Run. Do not create a second copy of a message already sent through the ordinary human-message form.
- Use complete authorization-aware context from the exact stored history range and pinned immutable Bot instructions, bounded by the existing transport/context limits. No group grant exposes configuration in API responses. Wait for the provider generation promise's terminal result, then publish exactly one Bot response and terminal Task/Run state under claim fencing and fresh authority.
