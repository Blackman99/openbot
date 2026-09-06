---
sequence: 42
id: KNW-01
title: "Promote text-like attachments into cited scoped knowledge"
status: complete
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

- [x] Uploading a supported file does not create knowledge until an authorized user previews extraction and confirms a target scope.
- [x] TXT, Markdown, JSON, CSV, TSV, and configured UTF-8 source-code files are extracted into chunks with file version and line or row locators.
- [x] A Bot run authorized for the selected scope can retrieve a matching chunk and return a source reference that opens the permitted file location.
- [x] A principal outside the selected scope is filtered before ranking and receives neither chunk content nor source metadata.
- [x] Extracted text is framed as untrusted data and a file instruction cannot alter Bot permissions, routing, system instructions, or budgets.
- [x] The complete promotion and citation flow works with PostgreSQL full-text search when no embedding service is configured.

## Non-goals

- PDF, DOCX, or XLSX parsing
- Image understanding
- Mandatory vector embeddings
- Continuous external-source synchronization

## Discovered implementation dependencies

First slice adds migration `0028_scoped_knowledge` and `text-line-row-v1` extraction. Upload and extraction preview return line or row chunks with file version 1 and write no `knowledge_documents` or `knowledge_chunks` rows. Confirming an explicit Bot, group, or Workspace destination now writes one document and its chunks after `acknowledged: true`; preview remains write-free. An authorized Bot run now retrieves a matching scoped chunk via scoped term search and returns an ATT-01 attachment source reference with the chunk line or row locator; selected locators persist in `0029_run_knowledge_references`. Human search and run selection apply destination scope in a `WITH authorized` CTE before `knowledge_fts_rank`, frame extracted text as untrusted `scoped_knowledge`, and match with PostgreSQL `tsvector`/`tsquery` via migration `0030_knowledge_full_text_search` when no embedding service is configured. An ILIKE path remains only if the FTS functions are missing. These are implementation notes for the original criteria, not new criteria.

## Completion evidence

Closed on 2026-09-05 against product HEAD `a7f4d31` with Verify [33989291158](https://github.com/Blackman99/openbot/actions/runs/33989291158) (all 16 jobs green), including native PostgreSQL memory/knowledge jobs.

1. Upload and extraction preview write no knowledge rows until an authorized confirmation names an explicit destination.
2. TXT, Markdown, JSON, CSV, TSV, and configured UTF-8 source files extract into chunks with file version and line or row locators.
3. An authorized Bot run retrieves a matching scoped chunk and returns an ATT-01 source reference that opens the permitted file location.
4. A principal outside the selected scope is filtered before ranking and receives neither chunk content nor source metadata.
5. Extracted text is framed as untrusted `scoped_knowledge` and cannot change Bot permissions, routing, system instructions, or budgets.
6. Promotion and citation use PostgreSQL full-text search when no embedding service is configured.
