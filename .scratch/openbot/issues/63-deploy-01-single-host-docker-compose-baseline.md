---
sequence: 63
id: DEPLOY-01
title: "Single-host Docker Compose baseline"
status: in-progress
blocked_by:
  - FND-01
  - WS-03
  - COL-18
  - DOC-01
labels:
  - area:deployment
  - area:docker
  - kind:feature
  - priority:mvp
---

# DEPLOY-01 — Single-host Docker Compose baseline

## Outcome

A clean single host can start the web/API, worker, PostgreSQL, and durable file storage and initialize its first administrator.

## Blocked by

- [FND-01](01-fnd-01-ship-the-first-deployable-end-to-end-slice.md)
- [WS-03](05-ws-03-manage-workspace-members-and-roles.md)
- [COL-18](35-col-18-price-model-usage-and-enforce-cost-budgets.md)
- [DOC-01](44-doc-01-query-pdf-docx-and-xlsx-knowledge-with-precise-locators.md)

## Acceptance criteria

- [ ] Following the documentation, one start command brings every container healthy and allows first-admin creation.
- [ ] Startup runs database migrations once, and a migration failure prevents readiness.
- [ ] Restarting every container preserves users, workspaces, task state, and attachments.
- [ ] Without public services configured, the deployment can use a model endpoint on its private network.
- [x] Telemetry is disabled by default, and an idle smoke test makes no unnecessary outbound request.
- [x] The default Compose configuration does not expose PostgreSQL or worker-only ports on the public host interface.

## Non-goals

- Kubernetes
- High-availability cluster
- Multi-region deployment


## Verification

- Tester direction PASS on AC5–6 at tip `f8ebc51` / Verify `34036429806` (20/20 green).
- Second TDD slice contracts AC1–4 Compose/README behavior (worker healthcheck, migrate-once gate, named-volume durability, private-network model wiring). Leave AC1–4 unchecked until Tester proves the live stack.
