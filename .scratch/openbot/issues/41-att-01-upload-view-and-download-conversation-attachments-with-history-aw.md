---
sequence: 41
id: ATT-01
title: "Upload, view, and download conversation attachments with history-aware access"
status: blocked
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

- [ ] The conversation UI and REST API accept an allowed file within the configured size limit and attach it to exactly one message.
- [ ] The uploaded file remains scoped to its conversation and is not inserted into long-term knowledge automatically.
- [ ] Only a principal allowed to read the attachment's message under the active history grant can view metadata or download the object.
- [ ] A removed Bot cannot access attachments on messages after its membership access upper bound.
- [ ] Oversized, disallowed, MIME-mismatched, interrupted, and checksum-invalid uploads fail without leaving an unreferenced object.
- [ ] Message purge deletes the stored object and all registered derived artifacts while retaining only a content-free audit record.

## Non-goals

- Text extraction
- Knowledge promotion
- Public share links
- External drive connectors
