---
sequence: 1
id: FND-01
title: "Ship the first deployable end-to-end slice"
status: complete-with-external-verification
blocked_by: []
labels:
  - foundation
  - vertical-slice
  - mvp
  - in-review
  - external-verification
---

# FND-01 — Ship the first deployable end-to-end slice

## Outcome

A fresh checkout starts the SvelteKit web app, Fastify API, and PostgreSQL, with the UI reporting live database and migration readiness.

## Blocked by

None. This ticket is ready for implementation.

## Acceptance criteria

- [ ] After copying the required values from .env.example, docker compose up --build starts the web app, API, and PostgreSQL.
- [x] GET /api/v1/status returns HTTP 200 and a stable, versioned payload when the database is reachable and migrations are current.
- [x] The status API returns HTTP 503 when the database is unavailable or migrations are stale, and the UI shows an unavailable state.
- [x] The status page calls the live HTTP API, with Playwright coverage for ready and unavailable states.
- [x] pnpm verify passes strict TypeScript checks, unit tests, integration tests, and production builds.
- [x] The repository includes AGPL-3.0, an executable migration command, and an .env.example with no real secrets.

## Verification

- `pnpm verify` passes locally with 44 unit/integration tests, 2 Playwright scenarios, and both production builds.
- The real Compose ready-to-outage smoke test is encoded in `.github/workflows/verify.yml`.
- Implementation is complete. The fresh-checkout Compose criterion remains deliberately unchecked because this execution environment has no Docker-compatible runtime and does not permit user namespaces.
- Verification exception `FND-01-E1` allows dependent implementation tickets to proceed locally, but it does not waive release acceptance: a Docker-capable run must supply the missing evidence before `REL-01` can complete.

## Non-goals

- Background workers or scheduling
- Kubernetes, high availability, or multi-region deployment
- A general-purpose UI component library
