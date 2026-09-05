---
sequence: 10
id: PROV-04
title: "Support Anthropic Messages-compatible models"
status: complete-with-external-verification
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

- [x] The personal connection UI and API accept a base URL, x-api-key, Anthropic version, custom headers, and model ID.
- [x] Plain text, streaming content blocks, and stop reasons produce unified internal model events.
- [x] tool_use blocks produce unified structured-action events; unsupported capability remains saved and recorded.
- [x] Timeouts, AbortSignal cancellation, rate limits, and upstream failures use the same normalized error classes as OpenAI adapters.
- [x] API keys, sensitive headers, request logs, and error bodies pass through the shared secret-redaction path.
- [x] Contract tests against an Anthropic-compatible mock cover text, streaming, tool_use, cancellation, rate limits, and errors.

## Non-goals

- Anthropic-hosted tools or Computer Use
- Provider account or billing management
- Executing automatic failover

## Implementation and verification — 2026-09-05

Integrated revision `87632a13197e13e5c6433503ddaf3785efe8ccef` passed 249 unit/integration tests, 8 browser scenarios, formatting, types and production builds. Independent specification review was clean on Anthropic candidate `e811f8b`. Standards review found a protocol-switch form-validation issue; a witnessed browser regression and fix `b58ec82` resolved it, and independent standards recheck was clean. Root inspected that narrow follow-up for acceptance-criteria regressions.

The existing shared transport, normalized events and encrypted JSON metadata support Anthropic without a new migration. The real provider runtime test now checks Anthropic version persistence as well as Responses. External gate `PROV-04-E1` remains explicit in REL-01 until the combined PostgreSQL and Compose jobs execute successfully. Detailed evidence is in [PROV-04 verification](../PROV-04-VERIFICATION.md).
