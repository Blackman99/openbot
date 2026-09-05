# Conversation attachments

ATT-01 publishes one validated file and one human message in the same conversation transaction. It never extracts content, writes knowledge, or creates public object URLs. An attachment is distinct from Bot avatars.

`ATTACHMENT_MAX_BYTES` defaults to 10485760 (10 MiB) and must be between 1 and 67108864 (64 MiB). API and Web use the same configured value. The Web adapter permits 65 MiB of multipart request data, while each file is checked independently. Avatar decoding and storage keep their independent 2 MiB bounds. Attachments reuse the configured private object backend with their own explicit maximum.

Accepted families are UTF-8 text, Markdown and CSV; static 8-bit PNG/JPEG (fully decoded, at most 8192 pixels per dimension and 16 million pixels); PDF; and DOCX/XLSX. Filename extension, declared media type, byte length, SHA-256, and actual signatures must agree. ZIP inspection checks the OOXML family, entries, checksums, non-overlapping local spans, and bounded decompression; encrypted archives, macros and arbitrary ZIP files are rejected. Documents are downloaded with attachment disposition; they are not executed or automatically extracted.

## REST publication

`POST /api/v1/workspaces/:workspaceId/conversations/:conversationId/attachments` uses the current session, exact trusted Origin, and `Content-Type: application/octet-stream`. The body is a 4-byte unsigned big-endian JSON-byte-count, at most 131072 bytes of UTF-8 JSON, then the exact file bytes. This avoids putting message content in HTTP headers or URL logs.

The JSON object has exactly these fields:

```json
{
  "idempotencyKey": "client-command-key",
  "body": "Human message",
  "filename": "notes.txt",
  "mediaType": "text/plain",
  "bytes": 5,
  "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
}
```

Success returns the ordinary `{receipt:{messageId,eventId,sequence}}`. The fingerprint includes message content, normalized filename, media type, exact length and hash. An unchanged retry returns its original receipt. A changed payload under the same key conflicts. Canonical identity and storage key are server-owned. The public attachment ID is separate from the private storage object key. The browser uses one multipart compose form; it never creates a text message first and attaches later.

`GET .../messages/:messageId/attachment` returns `{attachment:{id,filename,mediaType,bytes}}`. `GET`/`HEAD .../messages/:messageId/attachment/content` serves bounded bytes with private/no-store, nosniff and safe attachment disposition. Both endpoints require the current message-read authority; content reads recheck that authority after object I/O. The same-origin Web download path ends in `/messages/:messageId/attachment`.

Internal `AttachmentService.readGroup` accepts the human actor, workspace, group and exact active grant ID. Its transaction-owned eligibility check uses the original message creation sequence, the retained lower history bound, current grantor Bot authority, current human group access and the current tombstone. A public Bot ID is never an identity assertion. Removal closes access; re-invitation never unions older grants.

## Staging, derivatives and purge

A durable staged intent precedes object I/O. Fresh authority, a live upload lease, typed message event, immutable one-message reference and mandatory audit are committed together. A failed, interrupted, revoked or competing upload remains tracked for leased retryable cleanup. Late remote writes are reconciled through retained content-free deletion records. No success claims that failed storage was rolled back.

Purge preserves an in-flight derivative's staging lease. A confirmed finished write can release that lease promptly, while an adapter timeout keeps the original 60-second reconciliation lease because rejection does not prove background I/O has stopped. Ready message purges are selected before the batch limit, so an unavailable older object cannot starve later completed deletions.

`AttachmentService.registerDerived` is an internal downstream seam. It stages and validates every derived object under the original's exact workspace/conversation/message identity before saving. This ticket creates no derivatives automatically.

`POST .../messages/:messageId/purge` with `{}` is deliberately limited to attachment-bearing human messages, authorized for the current author or current group moderator. It returns `{purge:{state:"purging"}}` with HTTP 202, or `complete` with HTTP 200. Plain Task triggers and Bot outputs are not this entry point's scope. Task identity guards and command hashes are unchanged; future attachment-to-Task integration must extend the typed contract deliberately.

Purge first appends a tombstone and atomically registers cleanup for every original and derived object. Metadata, downloads, current context and version content immediately deny access. The cleanup worker retries unavailable storage. Only after all registered objects acknowledge deletion does the new migration-owned `purge_conversation_message` routine null that message's historical body/reason and redact its event command fingerprint. It preserves event identity/order/provenance and safe audits. The restricted runtime role has no general ledger UPDATE permission. Filenames, media type, bytes and hashes are removed from object records; only content-free reconciliation identities remain. Replaying a purged upload cannot recreate the message. Workspace retention purge remains a later ticket.

## Verification gates

Local API/BFF integration tests cover publication, reload/download, fingerprint conflict, authority after I/O, original sequence history, removal/re-invitation, interrupted upload, mandatory audit rollback, storage-unavailable cleanup after reconstruction, derivative deletion and two-workspace purge isolation. Browser coverage uploads a 3 MiB file, retries one command, reloads, downloads exact bytes and purges it.

`TEST_ATTACHMENT_DATABASE_URL` enables the dedicated native PostgreSQL acceptance file and CI job. This gate must execute the actual migration guards, restricted role, concurrent publication, audit rollback and redaction routine. `TEST_S3_*` enables the real private S3-compatible adapter gate, including the separate attachment versus avatar bounds. Local skips do not close either service gate.

## ATT-01 verification record

The implementation commit is `15df0ace6616eb483e2a6e069e59a9d40694dd25`, with reviewed tree `501056c459549d9565b800f982ccf66aaea18f1a`, based on `a5c094b096666127bffe0f42fea8e1a395b2d285`. The actual migration chain includes BOT-06's 0016, COL-04's 0017 and ATT-01's 0018; no predecessor placeholders were used.

Independent Standards and Specification reviews both reported CLEAN on that exact tree. Their findings were resolved with witnessed failing and passing regressions for OOXML declarations hidden in comments and valid single quotes, cumulative XML namespace amplification, an older failed deletion delaying a later ready purge, and purge overlapping a staged derivative write or an adapter timeout. The purge boundary regression confirms a plain queued Task trigger cannot be purged and still completes without changing its message identity.

On 2026-09-05, the final frozen-tree command `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration && pnpm build` exited successfully:

| Gate                               | Result     |
| ---------------------------------- | ---------- |
| Formatting and API/Web type checks | Passed     |
| API unit tests                     | 99 passed  |
| Web unit tests                     | 57 passed  |
| API integration tests              | 349 passed |
| Web integration tests              | 458 passed |
| Total local tests                  | 963 passed |
| API and Web production builds      | Passed     |

The attachment journey and three existing conversation browser journeys previously passed together (4/4), before the actual 0016/0017 integration and final review corrections. The dedicated merger must run the combined browser gate after COL-04 Web integration.

The five native PostgreSQL attachment tests remain an external gate, including restricted privileges, actual trigger behavior, concurrent publication, mandatory audit rollback, original/derivative redaction and the staged-write/purge overlap. The real S3-compatible gate and Compose acceptance script `infra/verify-attachments.mjs` also remain external. They were not run against local services and are not claimed as passed by the unit/integration evidence above.
