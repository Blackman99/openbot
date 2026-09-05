---
sequence: 64
id: DEPLOY-02
title: "Safe upgrades and schema compatibility gate"
status: blocked
blocked_by:
  - DEPLOY-01
labels:
  - area:deployment
  - area:migrations
  - kind:feature
  - priority:mvp
---

# DEPLOY-02 — Safe upgrades and schema compatibility gate

## Outcome

Administrators can upgrade a single-host instance explicitly, while incompatible schemas are prevented from starting.

## Blocked by

- [DEPLOY-01](63-deploy-01-single-host-docker-compose-baseline.md)

## Acceptance criteria

- [ ] Upgrading a fixture from the previous supported version passes all core smoke tests on the current release.
- [ ] A schema older or newer than the supported range prevents readiness and reports an actionable error.
- [ ] A migration lock ensures only one process applies migrations during concurrent startup.
- [ ] A failed migration does not record a successful version or let the API or worker accept new work.
- [ ] Upgrade documentation requires a backup and states the supported versions and recovery path.
- [ ] Post-upgrade tests cover login, group creation, task submission, and existing-history retrieval.

## Non-goals

- Arbitrary-version leap upgrades
- Zero-downtime online schema migration
- Automatic database downgrade
