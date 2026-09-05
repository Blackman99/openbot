# COL-03 conversation API and transaction handoff

The group/direct API, edits, tombstones, current projections, restartable cursors and Web pages are implemented. Local gates and both independent reviews pass; actual PostgreSQL/Compose proof remains the explicit COL-03-E1 integration gate.

## HTTP contract

All routes are session-authenticated beneath `/api/v1/workspaces/:workspaceId/conversations`. Responses are `private, no-store`; writes require the exact configured Origin. UUIDs canonicalize to lowercase. Unknown request fields are rejected. The server assigns all IDs, sequence, actor and time.

- `POST /` with `{subject:{kind:'group'|'direct-bot',id}}` opens the unique subject conversation and returns200 `{conversation}`. A direct subject ID is a Bot ID and always belongs to the acting human, never a supplied creator. Existing open returns the same conversation without another mutation audit.
- `POST /:conversationId/messages` with `{idempotencyKey,body}` returns200 `{receipt:{messageId,eventId,sequence}}`, identically for replay. Body is nonblank, preserves formatting, and is bounded to32,000 characters. Keys are1–128 printable non-space ASCII characters, scoped to actor and conversation.
- `GET /:conversationId?cursor=...&limit=...` returns `{conversation,messages,nextCursor,canWrite}`. Limit defaults30, maximum100. Messages order by original creation sequence. Cursor fixes a creation horizon but each page resolves current bodies/tombstones, including changes after that horizon. New creations after the horizon are excluded. Refresh without cursor starts a current page. Cursor is opaque to clients and has no process-memory dependency.
- `PATCH /:conversationId/messages/:messageId` with `{idempotencyKey,expectedVersion,body}` returns200 `{receipt}`. Expected version is a positive integer. Only the current human author can edit.
- `POST /:conversationId/messages/:messageId/tombstone` with `{idempotencyKey,expectedVersion,reason?}` returns200 `{receipt}`. A group owner/admin deleting another author's message must supply a nonblank reason, trimmed, maximum500. Author deletion defaults to `Deleted by author`. No undelete. Tombstones remain visible as deleted messages without their body.
- `GET /:conversationId/messages/:messageId/versions` returns200 `{versions}` only for current author/group owner/admin. Direct chains require the direct creator and current Bot inspect authority. Ordinary readers cannot obtain previous or deleted bodies.

400 `invalid_conversation_request`; 401 `authentication_required`; 403 `invalid_origin` or `conversation_forbidden`; 409 `idempotency_conflict` or `message_version_conflict`; unexpected failures503 `conversation_unavailable`. Reauthorize before replay; replay precedes version CAS. Errors never expose message bodies, SQL or private subject metadata. Status codes are authoritative; do not treat an upstream500 claiming authentication text as401.

## Exact response DTOs

The TypeScript source of truth is `apps/api/src/conversations/service.ts`; dates below serialize as ISO strings. Response allowlists must reject extra fields and malformed IDs/cursors/dates/integers without forwarding private upstream diagnostics.

```ts
interface Conversation {
  id: string;
  workspaceId: string;
  subject: { kind: 'group' | 'direct-bot'; id: string };
  createdAt: string;
}
interface MessageReceipt { messageId: string; eventId: string; sequence: number }
interface MessageProjection {
  id: string;
  creationSequence: number;
  versionEventId: string;
  sequence: number;
  version: number;
  author: { id: string; displayName: string };
  body: string | null;
  reason: string | null;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canDelete: boolean;
  canAudit: boolean;
}
interface ConversationPage {
  conversation: Conversation;
  messages: MessageProjection[];
  nextCursor: string | null;
  canWrite: boolean;
}
interface MessageVersion {
  id: string;
  sequence: number;
  type: 'message.created' | 'message.edited' | 'message.deleted';
  version: number;
  actor: { id: string; displayName: string };
  occurredAt: string;
  body: string | null;
  reason: string | null;
}
```

Sequences are positive safe integers, backed by a checked BIGINT counter. Creation sequence is immutable; sequence/versionEventId identify the current projection. Tombstones have null body and a reason; creation/edit versions have a body and null reason. Author points to the original human; version actor identifies who appended that edit/tombstone. A deleted projection cannot be edited or deleted again, but authorized audit may remain available. No email, idempotency key/hash, provider configuration or Bot instructions are returned.

## UI scope and boundary

Recommended entry: a workspace Conversations page linked from the existing workspace page. Offer explicit-member groups (GroupApiClient list rows with non-null role) and Bots with explicit ACL (BotApiClient list rows with non-null accessRole). Discovery alone never enables opening a conversation. Current API admission still decides after selection. Provider unavailability must not disable opening historical Bot conversations. Open through a POST action, then redirect to `/app/workspaces/:workspaceId/conversations/:conversationId`; do not create database rows from a GET loader.

The conversation page displays ordered messages with preserved formatting, deleted markers/reasons, allowed edit/delete/history controls, and next-page/refresh navigation. All permission booleans come from fresh projection. Use a distinct stable idempotency key per form command; preserve key, text and expectedVersion across transient failure/retry. A success redirects/reloads to generate a new command key. Conflicts must explain that the user needs a fresh version before resubmitting; never silently overwrite. Version-chain UI must be a separately authorized read and must not preload private history into ordinary pages. Label this as persistent conversation history; no Bot execution, Task, Run, generated response, SSE or history grants in this ticket.

BFF requests set Content-Type only when a JSON body exists and keep abort deadlines active through body parsing. Only actual401 clears the browser cookie. Malformed/upstream errors are masked; escaped Svelte text renders message content. Add targeted strict client/route/render tests and an isolated browser fixture/journey. A real API/client integration proves HTTP independently of the browser fixture.

## Borrowed transaction boundary

`ConversationTransaction.lock(connection, {actorUserId,workspaceId,conversationId}, now?, permission?)` in `apps/api/src/conversations/postgres-repository.ts` borrows an already-open transaction. Permission defaults `use`; historical reads select `inspect`. It acquires fresh workspace → group/Bot → conversation admission using the same locks as membership/ACL mutations. A direct conversation checks creator privacy before any read or write; provider availability is never consulted for history.

The returned admission's `append({idempotencyKey,body})`, `edit(messageId,command)` and `tombstone(messageId,command)` return `{receipt,replayed}`. Public HTTP returns only the stable receipt. Read-only admission cannot append. The caller retains COMMIT/ROLLBACK and connection ownership until all dependent writes/audits finish. COL-04 can insert its Task/Run after a fresh append and find their persisted receipt on replay. A downstream failure must roll back counter, event, idempotency receipt and audit together. No separate authorization transaction or memory counter is permitted. This module does not create Tasks/Runs.

Admission IDs are privately captured, canonicalized and frozen. Every SQL/audit scope uses those private IDs. `metadata` and `read().conversation` expose frozen detached snapshots with copied Dates; mutating any returned object cannot redirect subsequent reads or writes. Consumers must not reuse an admission after their transaction completes.

Coordinator decision: COL-03 retains NOT NULL message identity/version and a private counter. COL-02 will add an additive migration and typed membership append in this same admission/transaction, reusing the counter and mandatory audit; no second ledger/counter or allocate-only method. `currentPage` in projection.ts selects eligible original creation events before resolving current versions, preserving the history-grant boundary without implementing grants here. Later system events use the same sequence namespace; message creation positions need not be contiguous.

## Checkpoint evidence and remaining gates

The initial HTTP test failed404 before group open/append/replay existed. The borrowed-consumer replay test failed before its result exposed replay. Current-read and edit routes initially failed404; direct open initially failed400. Moderation initially failed404; pagination initially failed400. Each vertical slice became green before the next began. API typecheck and41 focused conversation/group/Bot/migration cases pass, including service reconstruction, horizon pagination with later edits/tombstones, immutable originals, replay-before-CAS, and direct creator privacy.

Final combined source a33a4e83 passes645 non-browser tests, repository formatting, both typechecks and both production builds. Browser-only candidate e599f4c passes18 ordinary scenarios plus one signed OIDC journey; both independent reviews are clean at that final source. The Standards mutable-metadata fix is included. See [COL-03-VERIFICATION](COL-03-VERIFICATION.md) for commands, review pins and the explicit native/Compose gate. Migration0014 remains provisional after published0012 and separately implemented BOT-02 migration0013.
