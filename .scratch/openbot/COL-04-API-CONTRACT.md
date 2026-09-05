# COL-04 single-Bot execution contract

This is the approved execution handoff translated into concrete HTTP/UI seams. The first green tracer implements direct submission/replay only; group submission, reads, execution, Bot output and deployment are subsequent slices. No endpoint below starts a process-local background generation.

## Submission and persistent reads

- Base `/api/v1/workspaces/:workspaceId/conversations/:conversationId/tasks`.
- `POST /` accepts exactly `{idempotencyKey,body,groupGrantId?}`. Body is nonblank and at most32,000 characters. Group conversations require one explicit active grant ID; direct conversations omit it and target their own Bot. It atomically creates one human message, Task and queued attempt1 with mandatory audits and fresh model-use admission by the actual human. Returns202 `{task}`. Same command/key returns its original Task, reauthorized before replay; mismatch returns409. The ordinary human-message endpoint is never called first.
- `GET /?cursor&limit` returns200 `{conversationId,tasks,nextCursor}` in trigger creation order; default20, maximum50. Opaque cursor is at most512 URL-safe characters and pins a creation horizon; each reload returns current persisted statuses. This is read-only and never creates a conversation.
- `GET /:taskId` returns200 `{task}` under current conversation inspection permission. Group history remains readable after a grant closes; direct histories remain creator-private. Reading does not need current provider availability or direct Bot ACL for an admitted group member.
- Writes require the exact trusted Origin; all responses are private/no-store. Only actual401 clears identity. Canonical UUIDs, exact fields, bounded success/error bodies and body deadlines follow existing clients.

## Safe DTOs

Task: `{id,conversationId,status,createdAt,bot,executionUser,groupGrantId,trigger,runs}`.

- `status`: queued/running/completed/failed.
- `bot`: `{id,name,versionId,versionNumber}` from the pinned immutable version, never its configuration.
- `executionUser`: `{id,displayName}`; always the triggering human.
- `groupGrantId`: exact retained grant UUID, ornull for a direct Task.
- `trigger`: `{messageId,eventId,sequence}` of the one committed human message.
- `runs`: ascending attempt records `{id,attempt,status,createdAt,startedAt,finishedAt,provider,usage,error,output}`. Time fields are ISOstrings; unstarted/unfinished dates are null. Only attempt1 exists in this ticket.
- `provider`: null before admission, otherwise `{protocol,modelId}` for the adapter/model actually selected. Connection/scope/revision are retained internally; endpoint, headers, credentials and sealed data never enter DTOs.
- `usage`: null before a call reports usage; otherwise `{inputTokens,outputTokens}`, cumulative snapshots, not sums of repeated snapshots.
- `error`: null or a fixed safe error-code string (never provider text): `execution_forbidden`, `model_unavailable`, `provider_failed`, `execution_timeout`, `output_limit`, `context_limit`, `worker_stopped`.
- `output`: null or the final Bot-message receipt `{messageId,eventId,sequence}`. Failed calls have no final output.

Current human message author DTOs stay `{id,displayName}`. Bot output adds the explicit union member `{kind:'bot',id,displayName,versionId,versionNumber}`. Bot outputs appear in ordinary conversation projections as message creation; their edit/delete/audit controls are false. Human mutation endpoints reject Bot outputs even when their audit/execution principal is the viewer. The original human projection remains compatible. The group-Bot context endpoint continues to return human projections only.

## UI slice

Add a persistent Tasks page under `/app/workspaces/:workspaceId/conversations/:conversationId/tasks`, linked from the conversation page. It owns a single task submission form: prompt text and, for groups, an explicit current grant selector showing safe Bot metadata. Direct conversations need no selector. Reload lists saved Task/Run status, pinned Bot name/version, attempt, actual protocol/model, usage and safe failure messages; link back to the conversation for the final response. Show an intentional refresh control and pagination; live streaming/polling/cancellation/retry actions belong to later tickets.

Preserve exact key/body/grant choices after unconfirmed outcomes and offer unchanged submission replay. Conflict feedback requires refresh before a new deliberate command. There is no second ordinary-message write. Decode the additive Bot-author union in conversation client/pages and display Bot/version authorship with no human edit/version controls. Group membership never exposes Bot instructions, binding IDs or avatar bytes.

The final-response link uses the conversation GET's optional messageId locator plus its message anchor. Locator and cursor are mutually exclusive; the existing limit remains bounded. Current conversation inspection permission is required before locating the target's original creation sequence inside that conversation. The returned bounded page contains the target's current projection and retains normal pagination. Missing/out-of-scope targets return the existing safe403; malformed/ambiguous locators return400. The group-Bot context endpoint's accepted query fields remain unchanged.

## Worker and evidence

PostgreSQL queued Runs are the durable queue, claimed by a separate worker entry point. Admission pins exact stored version/grant and the actual human provider rights under the established lock order. Commit claim token/deadline/actual provider metadata before network I/O. Wait for the entire bounded `generate` promise, then reauthorize and conditionally finalize the same claim with exactly one typed Bot output/status/audit transaction. No retries, fallback, cancellation UI, crash reclaim or routing are introduced here.

Migration0017 follows accepted BOT-06's0016; no placeholder migration is introduced. Until that accepted dependency arrives, the first tracer installs its provisional task schema only inside its test fixture. Final native PostgreSQL/Compose jobs must execute the integrated ordered schema, restricted privileges, locking, rollback, claim fencing and separate-worker persistence cases; local skips do not close those gates.
