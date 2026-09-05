---
sequence: 10
id: PROV-04
title: "Support Anthropic Messages-compatible models"
status: ready-for-agent
blocked_by:
  - PROV-01
labels:
  - provider
  - anthropic
  - adapter
  - vertical-slice
  - mvp
---

# PROV-04 — Support Anthropic Messages-compatible models

## Outcome

The connection flow supports Anthropic Messages and normalizes text streams, tool_use blocks, and errors through the shared model interface.

## Blocked by

- [PROV-01](07-prov-01-connect-a-personal-openai-chat-compatible-model.md)

## Acceptance criteria

- [ ] The personal connection UI and API accept a base URL, x-api-key, Anthropic version, custom headers, and model ID.
- [ ] Plain text, streaming content blocks, and stop reasons produce unified internal model events.
- [ ] tool_use blocks produce unified structured-action events; unsupported capability remains saved and recorded.
- [ ] Timeouts, AbortSignal cancellation, rate limits, and upstream failures use the same normalized error classes as OpenAI adapters.
- [ ] API keys, sensitive headers, request logs, and error bodies pass through the shared secret-redaction path.
- [ ] Contract tests against an Anthropic-compatible mock cover text, streaming, tool_use, cancellation, rate limits, and errors.

## Non-goals

- Anthropic-hosted tools or Computer Use
- Provider account or billing management
- Executing automatic failover
