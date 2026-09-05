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

Accepted at dedicated merge0bbaf8562fc2727cc5c563f1f3a1555cdd910779, tree4ec3bdd61b175c32ef53f773673623ba535a8629. Both independent source review axes and the shared integration review are CLEAN. The complete merged gate passed1,062 unit/integration tests,36 ordinary browser journeys and one signed OIDC journey, formatting, zero-error/zero-warning types and final builds. See [ATT-01 integration evidence](../ATT-01-INTEGRATION.md).

[Verify33959031255](../VERIFY-33959031255.md) passed all five actual restricted-role PostgreSQL attachment cases and the deployed Compose publication, private download and durable original/derived object purge through migration0018. ATT-01-E1 now retains only the new real-S3 large attachment/avatar byte-bound case: it timed out at the default 5,000 ms budget, with 7,823 ms reported, while the other 13 local/S3 cases passed. The independently reviewed case-only 30,000 ms budget correction is integrated as `86c77c6ce50478703ee32c5a0fb7a05dce24775e`; actual CI rerun remains required. No production deadline, retry count or assertion changed. See [S3 test-budget evidence](../ATT-01-S3-TEST-BUDGET.md).
