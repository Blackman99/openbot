---
sequence: 41
id: ATT-01
title: "Upload, view, and download conversation attachments with history-aware access"
status: complete
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

Accepted at dedicated merge0bbaf8562fc2727cc5c563f1f3a1555cdd910779, tree4ec3bdd61b175c32ef53f773673623ba535a8629. Both independent source review axes and the shared integration review are CLEAN. The complete merged gate passed1,062 unit/integration tests,36 ordinary browser journeys and one signed OIDC journey, formatting, zero-error/zero-warning types and final builds. See [ATT-01 integration evidence](../ATT-01-INTEGRATION.md).

ATT-01-E1 closed by [Verify33960029570](../VERIFY-33960029570.md), completed successfully on 2026-09-05 at 10:17:34 UTC with all 12 jobs green on the exact accepted local `e51fafe4` tree. Five actual restricted-role PostgreSQL attachment cases passed. All seven real private-S3 and seven local-store cases passed, including the 3 MiB attachment/avatar byte-bound case in 7,713 ms after the independently reviewed 30,000 ms case-budget correction `86c77c6ce50478703ee32c5a0fb7a05dce24775e`. General Compose passed fresh/upgrade through actual0018 and deployed private upload/download/acknowledged original and derived object purge. No production deadline, retry count or assertion changed; the earlier timeout remains documented in [S3 test-budget evidence](../ATT-01-S3-TEST-BUDGET.md).
