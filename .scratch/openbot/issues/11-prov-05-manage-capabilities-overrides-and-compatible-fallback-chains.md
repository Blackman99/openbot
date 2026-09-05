---
sequence: 11
id: PROV-05
title: "Manage capabilities, overrides, and compatible fallback chains"
status: ready-for-agent
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
---

# PROV-05 — Manage capabilities, overrides, and compatible fallback chains

## Outcome

Each model has an auditable capability catalog, while authorized administrators can justify overrides and define ordered, acyclic, capability-compatible fallback chains.

## Blocked by

- [PROV-02](08-prov-02-share-workspace-model-connections-without-sharing-secrets.md)
- [PROV-03](09-prov-03-support-openai-responses-compatible-models.md)
- [PROV-04](10-prov-04-support-anthropic-messages-compatible-models.md)

## Acceptance criteria

- [ ] Model details show Basic, Collaboration, and Enhanced capabilities with evidence, source, and last-probed time.
- [ ] Basic requires text and streaming; probes grant Collaboration only when reliable tool calling or structured output succeeds.
- [ ] Connection owners or workspace connection administrators can re-probe or add a manual override with a required rationale and persistent manual badge.
- [ ] Fallback chains reference only enabled, accessible models and reject duplicates, cycles, and candidates below the required capability.
- [ ] A resolution-preview API and UI deterministically show primary and fallback order plus exclusion reasons for a requested capability.
- [ ] Override and fallback changes use optimistic concurrency, expose no credentials, and emit complete audit events.
- [ ] Contract tests prove Basic models cannot resolve Collaboration work and that every manual override and re-probe remains attributable.

## Non-goals

- Retrying or switching models during task execution
- Silently inferring model prices
- Automatically trusting every endpoint-declared capability
