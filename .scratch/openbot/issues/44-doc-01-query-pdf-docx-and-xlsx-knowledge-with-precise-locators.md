---
sequence: 44
id: DOC-01
title: "Query PDF, DOCX, and XLSX knowledge with precise locators"
status: in-progress
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

- [ ] A text PDF promoted through the existing flow produces chunks with page-number locators and searchable content.
- [ ] A DOCX file produces chunks with heading and paragraph locators that resolve in the source viewer.
- [ ] An XLSX file produces chunks with worksheet and cell-range locators that resolve in the source viewer.
- [ ] Encrypted, corrupt, parser-unsupported, and configured-limit-exceeding files enter an explicit failed state and expose no partial knowledge.
- [ ] Uploading a replacement creates a new immutable file version instead of overwriting the prior version.
- [ ] After activation of a new version, new runs exclude the old version while historical citations still resolve for authorized auditors.

## Non-goals

- OCR for scanned PDFs
- Macros or formula execution
- Presentation-file parsing
- External document synchronization

## Discovered implementation dependencies

Migration `0032_document_knowledge_locators` extends chunk locator kinds with `page`, `paragraph`, and `cells` plus optional `locator_ref`. Text PDFs, DOCX, and XLSX extract through `document-page-cell-v1` after the existing ATT-01 upload checks. Failed encrypted, corrupt, unsupported, or over-limit files return an explicit error code and write no knowledge rows. A later upload of the same filename in the same scope creates the next immutable `file_version`; new run retrieval uses only the latest version while prior documents and attachments remain readable. These notes do not change the original acceptance texts, which stay unchecked.
