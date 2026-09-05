---
sequence: 2
id: AUTH-01
title: "Claim an instance and authenticate a local owner"
status: complete-with-external-verification
blocked_by:
  - FND-01
labels:
  - auth
  - security
  - vertical-slice
  - mvp
  - in-review
  - external-verification
---

# AUTH-01 — Claim an instance and authenticate a local owner

## Outcome

An unclaimed instance can atomically create its local administrator, default workspace, and owner membership, then provide a secure session lifecycle.

## Blocked by

- [FND-01](01-fnd-01-ship-the-first-deployable-end-to-end-slice.md)

`FND-01` implementation is complete under verification exception `FND-01-E1`; its Docker runtime evidence remains a release gate.

## Acceptance criteria

- [ ] The setup page atomically creates the first administrator, default workspace, and owner membership, then signs the user in.
- [ ] All subsequent and concurrent setup attempts are rejected without creating another instance administrator.
- [x] Passwords use Argon2id, and persistent session cookies are HttpOnly and SameSite, with Secure enabled in production.
- [x] Protected pages and APIs consistently redirect or return HTTP 401 for anonymous, expired, and signed-out sessions.
- [x] State-changing requests enforce Origin or CSRF checks, and tests prove a cross-site request cannot reuse the session.
- [ ] Append-only audit_events record setup, sign-in, and sign-out without passwords, cookies, tokens, or model secrets.

## Verification

- `pnpm verify` passed on 2026-09-05: API unit 46/46, API integration 37/37, Web unit 7/7, Web integration 22/22, Playwright 4/4, formatting, strict types, and both production builds.
- Implementation is complete. API service/HTTP tests, Web server tests, and browser scenarios cover initial setup, persistent sessions, expiry, sign-out, invalid credentials, Origin checks, setup-token protection, and safe audit contents.
- Passwords use real Node Argon2id tests; unknown accounts incur one verification using a precomputed dummy hash. Authentication failures are bounded by independent client and keyed-account windows.
- Database migrations use a serialized, ordered ledger. Readiness rejects missing, out-of-order, and unknown versions. The Compose API starts only after migration and runtime-role provisioning succeed.
- Runtime-role provisioning revokes inherited memberships and direct excess privileges, refuses runtime-owned database objects, and preserves audit history. CI tests real PostgreSQL rollback, concurrent setup, and audit UPDATE/DELETE/TRUNCATE rejection; Compose tests fresh and existing volumes, role downgrade, session lifecycle, and database outage.
- Verification exception `AUTH-01-E1`: real PostgreSQL and Docker Compose execution are unavailable locally. The atomicity, concurrency, and database-enforced append-only criteria deliberately remain unchecked until those jobs pass. This exception unlocks dependent local implementation; it remains a mandatory `REL-01` release gate.
- Independent final review found no remaining deterministic merge blocker. A browser regression caught duplicate SvelteKit cache headers after a failed action; the request-scoped fix passed the original failing scenario.

## Non-goals

- OIDC authentication
- Public registration or email delivery
- Password recovery or administrator-initiated resets
