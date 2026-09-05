---
sequence: 41
id: ATT-01
title: "Upload, view, and download conversation attachments with history-aware access"
status: complete-with-external-verification
blocked_by:
  - BOT-02
  - COL-02
  - COL-03
labels:
  - feature
  - area:attachments
  - area:authorization
  - mvp
---

# ATT-01 — Upload, view, and download conversation attachments with history-aware access

## Outcome

A member can attach a validated file to a conversation message, while object access follows conversation membership and history grants and the file remains conversation-local by default.

## Blocked by

- [BOT-02](13-bot-02-upload-and-securely-display-bot-avatars.md)
- [COL-02](19-col-02-add-bot-membership-and-history-grants.md)
- [COL-03](20-col-03-store-conversations-in-an-immutable-event-ledger.md)

## Acceptance criteria

- [x] The conversation UI and REST API accept an allowed file within the configured size limit and attach it to exactly one message.
- [x] The uploaded file remains scoped to its conversation and is not inserted into long-term knowledge automatically.
- [x] Only a principal allowed to read the attachment's message under the active history grant can view metadata or download the object.
- [x] A removed Bot cannot access attachments on messages after its membership access upper bound.
- [x] Oversized, disallowed, MIME-mismatched, interrupted, and checksum-invalid uploads fail without leaving an unreferenced object.
- [x] Message purge deletes the stored object and all registered derived artifacts while retaining only a content-free audit record.

## Non-goals

- Text extraction
- Knowledge promotion
- Public share links
- External drive connectors

## Acceptance evidence

Accepted at dedicated merge0bbaf8562fc2727cc5c563f1f3a1555cdd910779, tree4ec3bdd61b175c32ef53f773673623ba535a8629. Both independent source review axes and the shared integration review are CLEAN. The complete merged gate passed1,062 unit/integration tests,36 ordinary browser journeys and one signed OIDC journey, formatting, zero-error/zero-warning types and final builds. Actual PostgreSQL5, private S3 and deployed attachment Compose remain the explicit ATT-01-E1 release gate. See [ATT-01 integration evidence](../ATT-01-INTEGRATION.md).
