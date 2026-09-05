# COL-02 group Bot API and transaction handoff

Approved scope: group Bot invitations/removal, retained history grants and current context admission. No execution, Run, provider proxy or direct Bot configuration rights. The complete API and Web flow are implemented; independent review and final browser evidence are recorded in COL-02-VERIFICATION.md.

## HTTP and UI contract

Base: `/api/v1/workspaces/:workspaceId/groups/:groupId/bots`. Session authentication, exact Origin for writes, private/no-store responses and canonical UUIDs follow existing clients. Never clear an identity cookie except for an actual401.

- `GET /` returns `{groupId,grants,activeCount,maxActive:8,canManage}`. Group membership is required; management controls require current group owner/admin. Grant rows retain closed history.
- `POST /` accepts `{botId,idempotencyKey,history?}`. Omitted history means `{mode:'future-only'}`. Other choices are `{mode:'since-event',eventId}`, `{mode:'since-time',time}` (canonical ISO time, not future), or `{mode:'all'}`. Returns200 `{grant}`; repeated key/payload returns the same retained grant. Inviting requires group management and direct Bot use.
- `POST /:grantId/remove` accepts `{idempotencyKey}`, returning200 `{grant}`. Requires current group management; no direct Bot ACL is implied or required. The grant ID pins the removal target so a stale command cannot remove a replacement grant.
- `GET /:grantId/context?cursor&limit` returns `{grantId,conversationId,messages,nextCursor}` for that currently active grant. The requesting human must still belong to the workspace/group, and the recorded grantor must still have workspace membership and direct Bot use. Only allowed current human message projections are returned; no configuration, avatar object IDs, model binding or credentials.

Grant DTO: `{id,groupId,conversationId,bot,grantedBy,history,joined,closed}`. `bot` is safe `{id,name,roleDescription,description,canInspect}`; `grantedBy` is `{id,displayName}`; `joined` is `{eventId,sequence,at}`. `history` is `{mode,lowerBound}` with `eventId` only for since-event and `time` only for since-time. `closed` is null or `{eventId,sequence,at,reason}` where reason is `removed`, `bot-access-revoked`, or `workspace-access-removed`. All dates serialize as ISO strings. Group displays use the default Bot avatar; a separately authorized direct-inspection link may be shown when canInspect is true.

400 `invalid_group_bot_request`,401 `authentication_required`,403 `group_bot_forbidden`/`invalid_origin`,409 `idempotency_conflict`/`group_bot_already_active`/`group_bot_limit`/`group_bot_inactive`,503 `group_bot_unavailable`. Keep command key and unchanged choices across uncertain outcomes; use a new key only for a new intentional operation. Ordinary members may read membership/history summaries and allowed context, without management controls. Do not call a GET loader to create a conversation.

## Storage and borrowed transaction boundary

Migration0015 adds retained `group_bot_grants`, typed non-message membership identity on the existing `conversation_events`, and a partial unique active group/Bot key. The shared private append allocator always writes its typed event and required audit; no allocation-only operation is exported. Grant creation, conversation get-or-create, event and audit share one transaction. Membership events never enter human message projection.

Every writer locks workspace → stable ordered groups → Bot → conversation. Group admission and grantor checks remain current after waiting. Workspace removal and direct Bot ACL revocation lock all affected groups before Bot admission and append permanent closure events in the same mutation transaction. Their typed closure writer cannot read or write human content and does not grant administrators group-history access. Event actor is the actual revoking human; recorded grantor provenance is retained separately.

The context admission borrows the caller's transaction and pin exact grant/group/Bot/conversation IDs privately. It rejects closed grants, including old queued grant IDs after reinvitation. It selects original message creation eligibility before projecting current versions/tombstones. The lower bound is inclusive and persisted once; all-history starts at1, future-only at the join event. A new invitation never unions earlier grants. Any later provider call must authorize the actual requesting human independently; no grantor credentials are borrowed.

## Evidence status

See [COL-02-VERIFICATION](COL-02-VERIFICATION.md) for exact red → green, local test and independent review evidence. The completed non-browser gate has 809 passing tests, typechecks and production builds. Native PostgreSQL/Compose remain an explicit external gate; 14 native cases register but skip locally. UI/browser evidence is separate from database persistence and locking proof.

## Core implementation checkpoint

The full API core is implemented: all four history modes resolve a persistent inclusive boundary, current context filters original creation sequence before projecting edits/tombstones, removal pins one grant, and re-invitation creates a distinct grant. Active duplicate and ninth-seat checks execute under the same workspace/group locks. A model outage does not release a seat.

`GroupBotTransaction.lock(connection, access)` borrows an existing SQL transaction and captures a private canonical group/grant identity. Its only content method is `context(read)`, returning permitted human message projections with edit/delete/audit controls false. Keep the caller transaction open through dependent operations. No provider credential, Bot configuration, Task or Run admission is created.

Bot ACL deletion and workspace member removal prepare `GroupBotRevocations` before any Bot lock: workspace → affected groups in sorted order → affected Bots → conversations. This batch can only append typed grant-closure events and close the corresponding retained grants. The actual revoker is the event/audit actor; the original grantor remains separate provenance. Final Bot/member authority still belongs to the original mutation repository. Regrant/rejoin does not reopen a closed grant, and group role demotion alone does not close it.

Migration 0015 retains the existing ledger allocator and typed event identity. Native guards enforce immutable history/join identity, event provenance and irreversible closure; runtime has only SELECT/INSERT and the four closure-column UPDATE grants. Real PostgreSQL guard/concurrency/rollback verification remains an external CI gate; pg-mem does not establish those properties.

Core local verification: API typecheck and 42 focused tests passed (12 group Bot API, 1 migration rollback definition, 14 conversation, 15 Bot ACL). This includes an actual Fastify HTTP server plus the strict Web client for canonical UUIDs, replay/conflict, context and fixed-grant removal. The later full candidate adds Web pages and 14 native PostgreSQL test definitions with a dedicated CI job. Actual native execution remains external.
