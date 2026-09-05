---
sequence: 6
id: AUTH-02
title: "Sign in or accept invitations through optional OIDC"
status: complete
blocked_by:
  - WS-02
labels:
  - auth
  - oidc
  - security
  - vertical-slice
  - mvp
---

# AUTH-02 — Sign in or accept invitations through optional OIDC

## Outcome

An OIDC-enabled instance lets existing users explicitly link identities and invited users join without enabling public registration.

## Blocked by

- [WS-02](04-ws-02-join-a-workspace-through-a-one-time-invitation.md)

## Acceptance criteria

- [x] When OIDC is not configured, no OIDC action appears and local authentication is unchanged.
- [x] Configured sign-in uses Authorization Code, PKCE, state, and nonce, rejecting invalid or replayed values.
- [x] OIDC identities are keyed by issuer and subject; matching email addresses never trigger automatic account merging.
- [x] Existing users can link or unlink an OIDC identity only from an authenticated security-settings flow.
- [x] A new OIDC identity can create an account only with a valid workspace invitation.
- [x] End-to-end tests with a local mock identity provider cover linking, sign-in, invited registration, invalid state, and replay.

## Non-goals

- SAML, SCIM, or multi-provider administration
- Silent account merging by email
- Dynamic OIDC provider registration

## Verification

See [AUTH-02 verification](../AUTH-02-VERIFICATION.md) for the acceptance evidence, 257 passing local unit/integration checks, 8 passing browser scenarios, and the required external PostgreSQL/Compose release gates. Independent standards and spec reviews are both clean at `80ffeb150123c2b8c76789a3f5cc841b557caf67`. The real PostgreSQL and Compose release gates remain required and unrun locally.

Integrated as `84f05b2` with all 352 unit/integration tests, 9 ordinary browser scenarios, the real signed-IdP browser journey, formatting, types and production builds passing. The three narrow integration fixes received independent root review. `AUTH-02-E1` closed by [Verify33943166881](https://github.com/Blackman99/openbot/actions/runs/33943166881), successful on remote `20b0618c84dc2a3e2e582bf6e9de10f260e3de3f` at 2026-09-05 03:57:50 UTC. All five jobs passed, including real OIDC concurrency, rollback and restricted-role checks and the expanded Compose gate.
