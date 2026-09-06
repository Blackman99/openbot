---
sequence: 44
id: DOC-01
title: "Query PDF, DOCX, and XLSX knowledge with precise locators"
status: complete
blocked_by:
  - RET-01
labels:
  - feature
  - area:knowledge
  - area:documents
  - mvp
---

# DOC-01 — Query PDF, DOCX, and XLSX knowledge with precise locators

## Outcome

The existing scoped knowledge flow accepts common rich documents and spreadsheets and returns citations that resolve to pages, paragraphs, sheets, or cell ranges.

## Blocked by

- [RET-01](43-ret-01-assemble-a-permission-aware-provenance-preserving-model-context.md)

## Acceptance criteria

- [x] A text PDF promoted through the existing flow produces chunks with page-number locators and searchable content.
- [x] A DOCX file produces chunks with heading and paragraph locators that resolve in the source viewer.
- [x] An XLSX file produces chunks with worksheet and cell-range locators that resolve in the source viewer.
- [x] Encrypted, corrupt, parser-unsupported, and configured-limit-exceeding files enter an explicit failed state and expose no partial knowledge.
- [x] Uploading a replacement creates a new immutable file version instead of overwriting the prior version.
- [x] After activation of a new version, new runs exclude the old version while historical citations still resolve for authorized auditors.

## Non-goals

- OCR for scanned PDFs
- Macros or formula execution
- Presentation-file parsing
- External document synchronization

## Discovered implementation dependencies

Migration `0032_document_knowledge_locators` extends chunk locator kinds with `page`, `paragraph`, and `cells` plus optional `locator_ref`. Text PDFs, DOCX, and XLSX extract through `document-page-cell-v1` after the existing ATT-01 upload checks. Failed encrypted, corrupt, unsupported, or over-limit files return an explicit error code and write no knowledge rows. A later upload of the same filename in the same scope creates the next immutable `file_version`; new run retrieval uses only the latest version while prior documents and attachments remain readable. These notes do not change the original acceptance texts.

## Completion evidence

Closed on 2026-09-05 against product HEAD `60acdcf` with Verify [33991876320](https://github.com/Blackman99/openbot/actions/runs/33991876320) (all 16 jobs green), including `postgres-memories`, `code`, and `compose`.

1. A promoted text PDF stores searchable page locators and opens the source attachment.
2. DOCX chunks carry heading-path paragraph locators that resolve through the attachment viewer.
3. XLSX chunks carry worksheet and cell-range locators that resolve through the attachment viewer.
4. Encrypted, corrupt, unsupported, and over-limit files return explicit error codes and write no knowledge rows.
5. A later upload of the same filename creates the next immutable `file_version`.
6. New runs retrieve only the current version; historical citations and attachments remain readable.
