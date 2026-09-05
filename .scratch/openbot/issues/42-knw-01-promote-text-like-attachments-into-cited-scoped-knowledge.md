---
sequence: 42
id: KNW-01
title: "Promote text-like attachments into cited scoped knowledge"
status: in-progress
blocked_by:
  - ATT-01
  - MEM-01
  - COL-04
labels:
  - feature
  - area:knowledge
  - area:retrieval
  - mvp
---

# KNW-01 — Promote text-like attachments into cited scoped knowledge

## Outcome

Users can preview and explicitly promote text, Markdown, JSON, delimited tables, and UTF-8 source files into Bot, group, or Workspace knowledge that is searchable and cited by authorized runs.

## Blocked by

- [ATT-01](41-att-01-upload-view-and-download-conversation-attachments-with-history-aw.md)
- [MEM-01](37-mem-01-save-a-group-message-as-scoped-memory-and-use-it-in-the-next-answ.md)
- [COL-04](21-col-04-execute-a-single-bot-task-end-to-end.md)

## Acceptance criteria

- [ ] Uploading a supported file does not create knowledge until an authorized user previews extraction and confirms a target scope.
- [ ] TXT, Markdown, JSON, CSV, TSV, and configured UTF-8 source-code files are extracted into chunks with file version and line or row locators.
- [ ] A Bot run authorized for the selected scope can retrieve a matching chunk and return a source reference that opens the permitted file location.
- [ ] A principal outside the selected scope is filtered before ranking and receives neither chunk content nor source metadata.
- [ ] Extracted text is framed as untrusted data and a file instruction cannot alter Bot permissions, routing, system instructions, or budgets.
- [ ] The complete promotion and citation flow works with PostgreSQL full-text search when no embedding service is configured.

## Non-goals

- PDF, DOCX, or XLSX parsing
- Image understanding
- Mandatory vector embeddings
- Continuous external-source synchronization

## Discovered implementation dependencies

First slice adds migration `0028_scoped_knowledge` and `text-line-row-v1` extraction. Upload and extraction preview return line or row chunks with file version 1 and write no `knowledge_documents` or `knowledge_chunks` rows. Confirming an explicit Bot, group, or Workspace destination now writes one document and its chunks after `acknowledged: true`; preview remains write-free. An authorized Bot run now retrieves a matching scoped chunk via simple term search and returns an ATT-01 attachment source reference with the chunk line or row locator; selected locators persist in `0029_run_knowledge_references`. Pre-rank isolation, untrusted framing, and PostgreSQL full-text search remain later slices. These are implementation notes for the original criteria, not new criteria. All six acceptance texts stay unchecked.
