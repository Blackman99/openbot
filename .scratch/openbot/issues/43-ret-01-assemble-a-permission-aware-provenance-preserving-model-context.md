---
sequence: 43
id: RET-01
title: "Assemble a permission-aware, provenance-preserving model context"
status: complete
blocked_by:
  - MEM-04
  - KNW-01
  - COL-04
labels:
  - feature
  - area:retrieval
  - area:authorization
  - mvp
---

# RET-01 — Assemble a permission-aware, provenance-preserving model context

## Outcome

Each Bot run receives a deterministic token-bounded context assembled from only its visible ledger history, scoped memories, and knowledge chunks, with resolvable provenance for every derived item.

## Blocked by

- [MEM-04](40-mem-04-version-forget-and-revoke-scoped-memories.md)
- [KNW-01](42-knw-01-promote-text-like-attachments-into-cited-scoped-knowledge.md)
- [COL-04](21-col-04-execute-a-single-bot-task-end-to-end.md)

## Acceptance criteria

- [x] Authorization and history-grant filtering occurs before candidate ranking for ledger, memory, and knowledge sources.
- [x] The same inputs, permissions, and token budget produce the same ordered context item list.
- [x] When the budget is exceeded, the assembler follows a documented priority and never truncates or replaces system rules.
- [x] Every memory and knowledge item contains a resolvable source ID, scope, version, and locator in the run record.
- [x] Removed memberships, expired grants, tombstones, revoked items, and superseded versions never appear in newly assembled contexts.
- [x] Deleting all derived search data and rebuilding it from authoritative records yields an equivalent authorized retrieval result set.
- [x] An integration test with a deterministic fake provider proves that a displayed citation came from an item actually supplied to that run.

## Non-goals

- LLM reranking
- Required external embedding APIs
- Cross-Workspace retrieval
- Automatic source promotion

## Discovered implementation dependencies

First slice adds a deterministic assembler with documented priority `system`, `memory`, `knowledge`, then `ledger`. System rules are never truncated or replaced when the byte budget is exceeded; lower-priority kinds are dropped instead. Memory and knowledge items carry source ID, scope, version, and locator. Claim now runs authorization and history-grant selectors before assembly, persists only kept memory/knowledge/ledger locators, and fails only when complete system rules already exceed the shared byte budget. These notes do not change the original acceptance texts.

## Completion evidence

Closed on 2026-09-05 against product HEAD `364e78e` with Verify [33990602906](https://github.com/Blackman99/openbot/actions/runs/33990602906) (all 16 jobs green), including `postgres-memories` and `code`.

1. Claim selects authorized ledger, memory, and knowledge before `assembleRunContext` ranks or drops items.
2. The same collected items and budget produce the same kind-then-collection order.
3. Over-budget assembly keeps complete system rules and drops later kinds; oversized system instructions still fail `context_limit`.
4. Run records resolve memory and knowledge source ID, scope, version, and locator through `run_memory_references` / `run_knowledge_references` joins.
5. New claims omit forgotten, superseded, history-bound, and foreign-scope items.
6. Dropping and rebuilding `knowledge_chunk_fts_idx` yields the same authorized chunk IDs from `knowledge_chunks`.
7. A deterministic fake provider receives the same citation text and href later recorded for that run.
