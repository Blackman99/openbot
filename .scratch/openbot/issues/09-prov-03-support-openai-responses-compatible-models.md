---
sequence: 9
id: PROV-03
title: "Support OpenAI Responses-compatible models"
status: blocked
blocked_by:
  - PROV-01
labels:
  - provider
  - openai
  - adapter
  - vertical-slice
  - mvp
---

# PROV-03 — Support OpenAI Responses-compatible models

## Outcome

The connection flow supports the OpenAI Responses protocol and normalizes text, streams, and structured actions into internal model events.

## Blocked by

- [PROV-01](07-prov-01-connect-a-personal-openai-chat-compatible-model.md)

## Acceptance criteria

- [ ] The personal connection UI and API can explicitly select OpenAI Responses, a base URL, and a model ID.
- [ ] Plain text and streaming deltas produce the same internal text events as the Chat-compatible adapter.
- [ ] Structured output or function calls produce unified action events; unsupported capabilities remain saved but clearly marked.
- [ ] Custom headers, timeouts, AbortSignal cancellation, and upstream rate limits follow the shared adapter contract.
- [ ] Endpoint failures normalize to retryable, non-retryable, or unsupported-capability errors without exposing request secrets.
- [ ] Contract tests against a Responses-compatible mock cover text, streaming, structured actions, cancellation, and errors.

## Non-goals

- Replicating OpenAI-hosted tools
- File Search, Code Interpreter, or Web Search
- Automatic Chat-versus-Responses protocol selection
