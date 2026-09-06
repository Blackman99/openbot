---
sequence: 11
id: PROV-05
title: "Manage capabilities, overrides, and compatible fallback chains"
status: complete
blocked_by:
  - PROV-02
  - PROV-03
  - PROV-04
labels:
  - provider
  - capabilities
  - fallback
  - vertical-slice
  - mvp
  - implementation-complete
---

# PROV-05 — Manage capabilities, overrides, and compatible fallback chains

## Outcome

Each model has an auditable capability catalog, while authorized administrators can justify overrides and define ordered, acyclic, capability-compatible fallback chains.

## Blocked by

- [PROV-02](08-prov-02-share-workspace-model-connections-without-sharing-secrets.md)
- [PROV-03](09-prov-03-support-openai-responses-compatible-models.md)
- [PROV-04](10-prov-04-support-anthropic-messages-compatible-models.md)

## Acceptance criteria

- [x] Model details show Basic, Collaboration, and Enhanced capabilities with evidence, source, and last-probed time.
- [x] Basic requires text and streaming; probes grant Collaboration only when reliable tool calling or structured output succeeds.
- [x] Connection owners or workspace connection administrators can re-probe or add a manual override with a required rationale and persistent manual badge.
- [x] Fallback chains reference only enabled, accessible models and reject duplicates, cycles, and candidates below the required capability.
- [x] A resolution-preview API and UI deterministically show primary and fallback order plus exclusion reasons for a requested capability.
- [x] Override and fallback changes use optimistic concurrency, expose no credentials, and emit complete audit events.
- [x] Contract tests prove Basic models cannot resolve Collaboration work and that every manual override and re-probe remains attributable.

## Non-goals

- Retrying or switching models during task execution
- Silently inferring model prices
- Automatically trusting every endpoint-declared capability


## Implementation and verification

All seven acceptance criteria are implemented and both independent Standards and Spec reviews are
clean at code candidate `3468fa8649b74927354b94dd91ccad18652cfd52`. Capabilities carry attributable
probe/manual evidence and independent target generations; manual badges persist after re-probes or
target edits. Fallbacks remain inside one personal owner or one workspace and use atomic scope locks,
optimistic revisions and deterministic fresh-state previews. Basic-only models cannot resolve
Collaboration. Both personal and workspace pages provide safe catalog/management/preview flows.

Verified component suites total456 unit/integration tests (API77+171, Web22+186), with12 ordinary
browser scenarios. Final strict HTTP API/BFF checks, formatting, typechecks and production builds
passed. The Standards UUID/AAD finding is fixed using stored connection identity, preserving historical
personal encryption contexts; both original reviewers rechecked the final code. Browser tests use a
UI seam fixture and are separate from actual protocol/transport and database validation.

External gate `PROV-05-E1` remains pending actual PostgreSQL/Compose execution on the integrated
revision. Migration0011 and runtime/CI assertions cover policy storage, narrow grants, opposing-edge
concurrency, audit rollback and durable binding admission locks. Root owns REL-01 gate closure and
index/PROGRESS integration metadata. No runtime retries or Bot behavior were added.

See [PROV-05-VERIFICATION.md](../PROV-05-VERIFICATION.md) for version-specific commands, red/green
regressions, independent review evidence and integration seams, and
[PROV-05-API-CONTRACT.md](../PROV-05-API-CONTRACT.md) for safe API and internal model-admission contracts.

## Integrated gate

Integrated075a191 with the reviewed group CI response-contract fix85f8686. Full verification passed539 unit/integration tests (77 API unit,27 Web unit,204 API integration,231 Web integration),14 ordinary browsers and one real signed-IdP journey, formatting/types with zero Web warnings, and both builds. Root independently reviewed the additive fixture registration, ordered0011 ledger and narrow policy grants. Actual PROV-05-E1 remains an explicit REL-01 gate.

## Closed external evidence — PROV-05-E1

PROV-05-E1 closed by [Verify33945439831](https://github.com/Blackman99/openbot/actions/runs/33945439831), all five jobs successful on remote `4429ccdc8a61d6771b954c70dc0d6a1ab7b43873`, completed2026-09-05 at04:49:16 UTC. Published tree514ec8f9b70b5a760154171957ba566b0bf28242 exactly matches localf3d3671. The run passed539 code tests,14 ordinary browser scenarios plus one signed-IdP journey,16 auth/invitation/member/OIDC/group/token PostgreSQL cases,5 restricted provider cases, the separate OIDC privilege case and the complete fresh/upgrade/runtime-role/application/outage Compose flow.
