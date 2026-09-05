---
sequence: 7
id: PROV-01
title: "Connect a personal OpenAI Chat-compatible model"
status: complete
blocked_by:
  - AUTH-01
labels:
  - provider
  - openai
  - security
  - vertical-slice
  - mvp
  - implementation-complete
---

# PROV-01 — Connect a personal OpenAI Chat-compatible model

## Outcome

Users can save, test, and manage personal OpenAI Chat-compatible endpoints and models while credentials remain protected.

## Blocked by

- [AUTH-01](02-auth-01-claim-an-instance-and-authenticate-a-local-owner.md)

`AUTH-01` and its original external evidence are complete under successful baseline Verify run `33938570768`.

## Acceptance criteria

- [x] The settings UI and API create, inspect, update, disable, and delete a personal connection with name, base URL, API key, custom headers, and model ID.
- [x] A pre-save test performs a live text stream and structured-action probe, then stores timestamped raw results.
- [x] API keys and sensitive headers use authenticated encryption with a random nonce; reads return only configured markers or masks.
- [x] Logs, errors, audits, and exports contain no API keys, Authorization values, or sensitive headers.
- [x] Only the connection owner can inspect metadata or invoke the endpoint; guessed IDs return HTTP 403 or 404.
- [x] URLs outside the instance's allowed schemes, hosts, or CIDRs are rejected before any network connection.
- [x] An OpenAI-compatible mock covers success, authentication failure, timeout, cancellation, and interrupted streams, with secrets removed from errors.

## Non-goals

- The OpenAI Responses protocol
- The Anthropic Messages protocol
- Automatic fallback during task execution

## Implementation evidence — 2026-09-05

Integrated commit `af206cfeb2486254783e6170dc874fa07a320bbe` passes formatting, types,145 unit/integration tests,6 browser scenarios, and API/Web production builds. Two independent review axes found three defects; all were fixed with witnessed regressions and root rechecked13 focused tests. Details and downstream adapter seams are in [PROV-01-VERIFICATION.md](../PROV-01-VERIFICATION.md).

External gate `PROV-01-E1` closed: [Verify33941168646](https://github.com/Blackman99/openbot/actions/runs/33941168646) passed on published commit `98f15fc88cdc44bc6cd14ac5542a9aad3fb58166`, completed on 2026-09-05 at 03:13:55 UTC. The provider runtime test passed with actual migration and restricted-role provisioning, while authentication, invitation concurrency, and Compose checks also passed. The missing infrastructure `pg` dependency discovered in the preceding run was reproduced and fixed before this successful run.
