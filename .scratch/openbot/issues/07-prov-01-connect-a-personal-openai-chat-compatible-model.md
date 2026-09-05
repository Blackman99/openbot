---
sequence: 7
id: PROV-01
title: "Connect a personal OpenAI Chat-compatible model"
status: ready-for-agent
blocked_by:
  - AUTH-01
labels:
  - provider
  - openai
  - security
  - vertical-slice
  - mvp
  - ready-for-agent
---

# PROV-01 — Connect a personal OpenAI Chat-compatible model

## Outcome

Users can save, test, and manage personal OpenAI Chat-compatible endpoints and models while credentials remain protected.

## Blocked by

- [AUTH-01](02-auth-01-claim-an-instance-and-authenticate-a-local-owner.md)

`AUTH-01` implementation is complete under external verification exception `AUTH-01-E1`.

## Acceptance criteria

- [ ] The settings UI and API create, inspect, update, disable, and delete a personal connection with name, base URL, API key, custom headers, and model ID.
- [ ] A pre-save test performs a live text stream and structured-action probe, then stores timestamped raw results.
- [ ] API keys and sensitive headers use authenticated encryption with a random nonce; reads return only configured markers or masks.
- [ ] Logs, errors, audits, and exports contain no API keys, Authorization values, or sensitive headers.
- [ ] Only the connection owner can inspect metadata or invoke the endpoint; guessed IDs return HTTP 403 or 404.
- [ ] URLs outside the instance's allowed schemes, hosts, or CIDRs are rejected before any network connection.
- [ ] An OpenAI-compatible mock covers success, authentication failure, timeout, cancellation, and interrupted streams, with secrets removed from errors.

## Non-goals

- The OpenAI Responses protocol
- The Anthropic Messages protocol
- Automatic fallback during task execution
