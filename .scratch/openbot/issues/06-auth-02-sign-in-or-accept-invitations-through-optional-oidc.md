---
sequence: 6
id: AUTH-02
title: "Sign in or accept invitations through optional OIDC"
status: ready-for-agent
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

- [ ] When OIDC is not configured, no OIDC action appears and local authentication is unchanged.
- [ ] Configured sign-in uses Authorization Code, PKCE, state, and nonce, rejecting invalid or replayed values.
- [ ] OIDC identities are keyed by issuer and subject; matching email addresses never trigger automatic account merging.
- [ ] Existing users can link or unlink an OIDC identity only from an authenticated security-settings flow.
- [ ] A new OIDC identity can create an account only with a valid workspace invitation.
- [ ] End-to-end tests with a local mock identity provider cover linking, sign-in, invited registration, invalid state, and replay.

## Non-goals

- SAML, SCIM, or multi-provider administration
- Silent account merging by email
- Dynamic OIDC provider registration
