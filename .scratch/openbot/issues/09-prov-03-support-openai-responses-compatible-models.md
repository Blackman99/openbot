---
sequence: 9
id: PROV-03
title: "Support OpenAI Responses-compatible models"
status: complete
blocked_by:
  - PROV-01
labels:
  - provider
  - openai
  - adapter
  - vertical-slice
  - mvp
  - implementation-complete
---

# PROV-03 — Support OpenAI Responses-compatible models

## Outcome

The connection flow supports the OpenAI Responses protocol and normalizes text, streams, and structured actions into internal model events.

## Blocked by

- [PROV-01](07-prov-01-connect-a-personal-openai-chat-compatible-model.md)

## Acceptance criteria

- [x] The personal connection UI and API can explicitly select OpenAI Responses, a base URL, and a model ID.
- [x] Plain text and streaming deltas produce the same internal text events as the Chat-compatible adapter.
- [x] Structured output or function calls produce unified action events; unsupported capabilities remain saved but clearly marked.
- [x] Custom headers, timeouts, AbortSignal cancellation, and upstream rate limits follow the shared adapter contract.
- [x] Endpoint failures normalize to retryable, non-retryable, or unsupported-capability errors without exposing request secrets.
- [x] Contract tests against a Responses-compatible mock cover text, streaming, structured actions, cancellation, and errors.

## Non-goals

- Replicating OpenAI-hosted tools
- File Search, Code Interpreter, or Web Search
- Automatic Chat-versus-Responses protocol selection

## Implementation evidence — 2026-09-05

Implemented on `ticket/prov-03`: candidate `a855726`, completion-probe fix `977b949`, shared
transport/SSE review fixes `271aa4a`. All 172 unit/integration tests, formatting, typechecks,
API build, and the unchanged web build pass; all 6 browser scenarios pass. Independent review
results and red/green evidence are recorded in [PROV-03 verification](../PROV-03-VERIFICATION.md).

External gate `PROV-03-E1` closed under [Verify33941574408](https://github.com/Blackman99/openbot/actions/runs/33941574408) on remote commit `8f7e47f50a935cffc849e29c73b48a89d75ee449`, completed on 2026-09-05 at 03:22:16 UTC. Code, authentication/invitation PostgreSQL, provider protocol persistence under the restricted role, and Compose all passed. The integrated local gate passed 213 unit/integration tests and 7 browser scenarios.
No migration was required; saved protocol metadata defaults legacy records to Chat Completions.
