---
sequence: 67
id: REL-01
title: "MVP release acceptance and distribution"
status: blocked
blocked_by:
  - API-06
  - ROUT-02
  - NOTIF-02
  - DATA-05
  - DEPLOY-03
  - PWA-01
  - BOT-04
  - COL-19
  - TPL-02
  - DOC-01
  - IMG-01
labels:
  - area:release
  - kind:verification
  - priority:mvp
---

# REL-01 — MVP release acceptance and distribution

## Outcome

A clean-instance acceptance suite proves the complete multi-user, multi-model collaboration loop and produces a reproducible MVP release artifact.

## Blocked by

- [API-06](53-api-06-resumable-permission-scoped-sse-event-stream.md)
- [ROUT-02](55-rout-02-cron-routines-with-time-zone-and-overlap-safety.md)
- [NOTIF-02](57-notif-02-mention-notifications-and-per-group-muting.md)
- [DATA-05](62-data-05-enforce-retention-and-final-purge.md)
- [DEPLOY-03](65-deploy-03-consistent-backup-and-restore.md)
- [PWA-01](66-pwa-01-online-first-responsive-web-pwa.md)
- [BOT-04](15-bot-04-grant-bot-owner-editor-and-user-permissions.md)
- [COL-19](36-col-19-pause-tasks-for-human-input-and-approval.md)
- [TPL-02](47-tpl-02-atomically-import-and-export-a-safe-bot-team-template.md)
- [DOC-01](44-doc-01-query-pdf-docx-and-xlsx-knowledge-with-precise-locators.md)
- [IMG-01](45-img-01-send-authorized-image-attachments-to-vision-capable-models.md)

## Acceptance criteria

- [ ] The release guide initializes a clean Compose instance with healthy services, applied migrations, and a first administrator.
- [ ] Automated acceptance uses two users, two provider protocols, and three distinct bots to create a group, select a lead, delegate, hand off, and synthesize disagreement.
- [ ] Acceptance covers observation, pause, resume, cancellation, retry, approval, restart recovery, and budget exhaustion without state loss.
- [ ] History grants, membership permissions, cross-group memory, and workspace isolation all block unauthorized reads.
- [ ] Attachments promoted to knowledge, template import/export, routines, public API, SSE, and notifications each complete one end-to-end loop.
- [ ] Endpoint failure and repeated idempotent requests create no duplicate task and lose no confirmed state.
- [ ] Export followed by soft deletion and final purge removes all target content while preserving a neighboring workspace.

## Required external evidence

`FND-01-E1`, `AUTH-01-E1`, and `WS-01-E1` are closed by [Verify33938570768](https://github.com/Blackman99/openbot/actions/runs/33938570768) on published commit `ecc586a8d3b528728af2308e247c4c3c4fb75ffa`, completed successfully on2026-09-05 at02:17 UTC. The `code`, `postgres-auth`, and `compose` jobs all passed, including the real workspace isolation/failed-audit rollback and restricted runtime-role workspace smoke tests.

This evidence covers the first three tickets only. Each subsequently implemented ticket must retain any unexecuted external gate here, and the complete release acceptance criteria above must still pass against the final integrated revision.

## Closed external gate — PROV-01-E1

- [x] Execute `postgres-providers` with real migration and runtime privilege provisioning; prove encrypted persistence, owner isolation, stale-write rejection, audit-failure rollback, deletion, and forbidden runtime DDL/audit updates.
- [x] Keep `postgres-auth` and Compose green on the combined provider revision.

## Closed external gate — WS-02-E1

- [x] Execute the isolated-schema invitation PostgreSQL tests for concurrent consumption, revocation, duplicate-email signup and transaction rollback.
- [x] Execute the integrated Compose invitation creation, acceptance, replay, revocation, hash-only persistence and audit checks with the restricted runtime role; verify its exact column privileges.

Both gates closed under [Verify33941168646](https://github.com/Blackman99/openbot/actions/runs/33941168646) on published commit `98f15fc88cdc44bc6cd14ac5542a9aad3fb58166`, completed on 2026-09-05 at 03:13:55 UTC. All four jobs passed: code, postgres-auth (4 real tests), postgres-providers (1 real restricted-role test), and Compose. Integrated local revision `62b0ab6` passed 186 unit/integration tests, 7 browser scenarios, formatting, types and both production builds. This evidence closes these ticket gates; the final release criteria still require verification on the final integrated revision.

## Non-goals

- HA or multi-region certification
- Kubernetes distribution
- Native clients
- Features outside the MVP contract


## Closed external gate — PROV-03-E1

- [x] Run the combined `postgres-providers` job on the PROV-03 revision, including explicit
  Responses protocol round-trip through the real restricted runtime role and encrypted storage.
- [x] Keep `postgres-auth` and Compose green on that combined revision. Earlier PROV-01/WS-02
  evidence does not certify later provider protocol/transport changes.

Local evidence and independent reviews are recorded in [PROV-03 verification](../PROV-03-VERIFICATION.md).

PROV-03-E1 closed by [Verify33941574408](https://github.com/Blackman99/openbot/actions/runs/33941574408), all four jobs successful on remote `8f7e47f50a935cffc849e29c73b48a89d75ee449`, completed on 2026-09-05 at 03:22:16 UTC.

## Closed external gate — PROV-04-E1

- [x] Execute the combined provider PostgreSQL test with both Responses and Anthropic, including persisted Anthropic version metadata and restricted-role storage, ownership, stale revisions and audit rollback.
- [x] Keep authentication/invitation PostgreSQL and Compose green on the same integrated revision.

Local combined verification at `87632a1` passed 249 unit/integration tests and 8 browser scenarios. [Verify33942334386](https://github.com/Blackman99/openbot/actions/runs/33942334386) passed all four jobs on remote `6fb668702377ba18fd39c2c7439f4112887f77fa`, completed on 2026-09-05 at 03:39:21 UTC, closing PROV-04-E1.

## Closed external gate — WS-03-E1

- [x] Execute the real PostgreSQL membership concurrency and rollback tests, including simultaneous last-owner changes and actor rechecks.
- [x] Execute the integrated Compose member provenance, role boundaries, last-owner rejection, removal with retained authentication, preserved history and audit checks using the deployed runtime role.
- [x] Verify membership DELETE and role-only UPDATE privileges, and the ordered migration ledger through `0006_workspace_member_provenance`.

Integrated revision `faea29a` passed 284 unit/integration tests, 9 browser scenarios, formatting, types and builds. The new deployment smoke was independently reviewed and all 20 workflow shell steps passed syntax checks. Actual PostgreSQL/Compose execution remains required; this explicit exception unlocks local PROV-02, COL-01 and API-01 work.

WS-03-E1 closed by [Verify33942927588](https://github.com/Blackman99/openbot/actions/runs/33942927588) on remote `027afbfb71e29d7f27d8249d5a72ddaa39adb332`, completed successfully on 2026-09-05 at 03:52:14 UTC. All four jobs passed, including seven real authentication/invitation/member PostgreSQL tests, the separate restricted-role provider suite and the complete Compose member smoke. This closes the earlier local-only exception; final release acceptance still runs against the final combined revision.

## Closed external gate — AUTH-02-E1

- [x] Execute actual PostgreSQL OIDC callback/invitation concurrency, atomic rollback and session revocation tests alongside the existing auth/invitation/member invariants.
- [x] Execute the isolated `postgres-oidc` job using the deployment grant script and restricted runtime role; verify link, sign-in, invited registration, unlink, final-credential protection, rollback and least privilege.
- [x] Keep provider PostgreSQL and Compose fresh/upgrade, runtime-role and application smoke checks green through the ordered `0007_oidc` migration.

Integrated revision `84f05b2` passed 352 unit/integration tests, 9 ordinary browser scenarios and one real Fastify/signed-IdP journey, formatting, types and production builds. Both review axes are clean; root independently reviewed the configuration-first startup import, deterministic response-body deadline regression and resource-bounded API integration test workers. The PostgreSQL/Compose gate remains unexecuted locally; pg-mem and browser fixtures do not replace it.

AUTH-02-E1 closed by [Verify33943166881](https://github.com/Blackman99/openbot/actions/runs/33943166881), completed successfully on 2026-09-05 at 03:57:50 UTC on remote `20b0618c84dc2a3e2e582bf6e9de10f260e3de3f`. All five jobs passed: code, postgres-auth (11 actual tests), the isolated postgres-oidc restricted-role test, postgres-providers and Compose. Final REL-01 acceptance remains required on the final combined revision.

## Closed external gate — PROV-02-E1

- [x] Run the actual restricted-role provider PostgreSQL suite for shared connection lifecycle, cross-admin credentials, authority rechecks, stale revisions, audit rollback and workspace-lock revocation admission.
- [x] Keep all authentication/OIDC PostgreSQL and Compose jobs green on the shared-model revision, including exact shared-connection table/column privileges and the ordered ledger through0008.

Integrated `3c515b6` passed 400 unit/integration tests, 10 ordinary browser scenarios and one real signed-IdP journey, formatting, types and builds. Both independent review axes are clean, including the UUID/AAD correction; new Compose assertions received independent root review. Real PostgreSQL/Compose remains pending; this explicit gate permits local PROV-05 work without treating local skips as evidence.

PROV-02-E1 closed by [Verify33943840316](https://github.com/Blackman99/openbot/actions/runs/33943840316), all five jobs successful on remote `3f4e39145b4b3af53ed49c182eacaadb0144740c`, completed on 2026-09-05 at 04:12:53 UTC. All three restricted provider tests and the shared-role Compose assertions passed.

## Closed external gate — COL-01-E1

- [x] Execute the three real PostgreSQL group concurrency/rollback cases, including current eligible-owner counts, waiting-actor authorization and atomic audit failures across group mutations.
- [x] Execute the deployed-role Compose group lifecycle: private/discoverable boundaries, explicit roles, immediate workspace-removal denial, retained-grant restoration by invitation, eligible-last-owner rejection, preserved authors and exact safe/no-op audits.
- [x] Verify exact group/group-membership table and column privileges and the ordered migration ledger through0009, with all earlier provider/auth/OIDC checks green.

Integrated `b7dc8fe` passed 445 unit/integration tests, 11 ordinary browser scenarios and one real signed-IdP journey, formatting, types and both builds. Both review axes are clean at e3677ad; root independently reviewed the new Compose lifecycle, nine expected group audits, privileges and historical migration fixture. Actual PostgreSQL/Compose remains pending on this revision; local fixtures are not external evidence.

Verify33944259379 on remote c547c6c passed code, postgres-auth (including the three group cases), postgres-providers and postgres-oidc. Compose failed before group assertions in pre-authentication database seeding because the socket readiness probe admitted the temporary initialization server. The independently reviewed fix2ed018e, integrated4943df0, uses authenticated target-database TCP readiness with bounded probes in Compose, seeding and all three native services; its 10 focused checks, types/lint and 31 shell syntax checks pass. COL-01-E1 stays open pending an actual complete retry.

## Closed external gate — API-01-E1

- [x] Execute both native PostgreSQL API token cases for atomic audit rollback, concurrent creation/member removal, and identical-timestamp rejoin without credential revival.
- [x] Execute `infra/verify-api-tokens.mjs` against the deployed restricted runtime role, proving one-time plaintext/hash-only storage, public identity, fixed scopes, immutable SQL fields, idempotent revocation and permanent member-removal revocation.
- [x] Keep all earlier auth/OIDC/provider/group checks and fresh/upgrade Compose startup green through the ordered0010 migration.

Integrated47a6008 passed478 unit/integration tests,12 ordinary browser scenarios and one real signed-IdP journey, formatting/types/builds. Original Standards and Spec reviews are clean at96ab273; root independently reviewed integration deltas and the bounded canonical member-removal audit followup498fdec (integrated3c7783d). These local checks do not replace actual PostgreSQL/Compose execution.

## Closed external gate — PROV-05-E1

- [x] Execute actual restricted-role provider PostgreSQL cases for both scopes: opposing concurrent fallback edits, policy/audit rollback, users UPDATE denial and provider admission locks held through the caller transaction.
- [x] Verify fresh/upgrade Compose through0011 and exact shared policy UPDATE privileges, preserving all prior group/token/auth/OIDC/provider checks.

Integrated075a191 passed539 unit/integration tests,14 ordinary browser scenarios plus one real signed-IdP journey, formatting/types/builds and31 shell syntax checks. Both independent reviews are clean3468fa8; root reviewed only additive integration resolutions and group CI patch85f8686. This explicit external exception unlocks local BOT-01 implementation; pg-mem and browser fixtures do not substitute for the pending database/runtime evidence.

API/group retry33944859922 passed482 code tests,13 browser journeys and all three native PostgreSQL jobs, including16 auth/invitation/member/OIDC/group/token cases. Compose failed because the group smoke expected a role in the invitation identity projection. Reviewed patch85f8686, integrated075a191, corrects the assertion using the actual member-list API; complete Compose retry remains mandatory for COL-01-E1 and API-01-E1.

## Combined group, token and capability gate closure

COL-01-E1, API-01-E1 and PROV-05-E1 are closed by [Verify33945439831](https://github.com/Blackman99/openbot/actions/runs/33945439831), all five jobs successful on remote `4429ccdc8a61d6771b954c70dc0d6a1ab7b43873`, completed2026-09-05 at04:49:16 UTC. Published tree514ec8f9b70b5a760154171957ba566b0bf28242 exactly matches localf3d3671. The run passed539 code tests,14 ordinary browser scenarios plus one signed-IdP journey,16 auth/invitation/member/OIDC/group/token PostgreSQL cases,5 restricted provider cases, the separate OIDC privilege case and the complete fresh/upgrade/runtime-role/application/outage Compose flow. The group smoke now uses the real membership response contract, and its full deployment lifecycle/nine-audit assertions pass. The deployed API-token smoke reports successful hash-only storage, fixed scope/immutable-field privileges and permanent revocation. Both policy scope concurrency/rollback/admission-lock cases passed against real PostgreSQL. These closures supersede the pending historical notes above; final REL-01 acceptance still runs on the final combined release revision.

## Closed external gate — BOT-01-E1

- [x] Execute all eight dedicated `postgres-bots` cases using the deployed restricted role: atomic creation, same-Bot deferred pointer at COMMIT, immutable versions and exact grants, mandatory audit rollback, current authority and both lock orderings for provider disable/member removal, and post-admission creation time.
- [x] Execute fresh/upgrade Compose through `0012_bot_identity`, verifying exact Bot table/column/function privileges and preserving all earlier runtime checks.

BOT-01 integrated as `ccda8d5ce10527e71ad0fd7c879d29b862589cb7`, tree `83b4549995ebc60c6ad93ac1db5de1cb0b9c7590`. Both independent review axes are clean at code `cdeff01`; final author `ce54b78` adds only evidence/ticket documentation. Dedicated merger `pnpm verify` exited0:594 unit/integration tests,15 ordinary browser scenarios,one signed-OIDC journey,formatting/types/builds all passed. YAML,26 shell steps and changed MJS syntax also passed. No integration source fix was needed. The eight local native cases were skipped without a database; this explicit release gate permits BOT-02, BOT-04 and COL-03 implementation but does not claim actual database or Compose success.

BOT-01-E1 closed by [Verify33947013084](https://github.com/Blackman99/openbot/actions/runs/33947013084), all six jobs successful on remote `6d5f6fc6be367546591228681fd975fb94448c5c`, completed2026-09-05 at05:24:36 UTC. The published tree `88d4a39ad4ff129d7ff032ea7e64c90a075d23af` exactly matches local `47553b1e5331aeaa869d44e96537b38d53d9fd2b`, verified by fetch and tree diff. The dedicated `postgres-bots` job101255004109 executed all8 cases successfully against PostgreSQL17 with the real restricted role. Compose job101255004094 passed fresh/upgrade migration0012, exact Bot table/column/function privileges and every prior application/outage check. Code, postgres-auth, postgres-providers and postgres-oidc also passed. This actual evidence supersedes earlier pending notes; no skipped test is counted as passed.

## Closed external gate — BOT-04-E1

- [x] Execute all nine `bot-acl-runtime.test.ts` cases with the deployed restricted role, including concurrent eligible-owner changes, current membership/ACL admission and required audit rollback.
- [x] Keep the existing eight Bot identity cases green in the preceding separate command; do not run fixed-role provisioning files concurrently.
- [x] Execute fresh/upgrade Compose with the precise visibility and ACL role/delete privileges, keeping all earlier database and application checks green.

BOT-04 integrated as `8d1933f51ff43c1c01616e8d885cf9ae75e41995` without source fixes. Both independent review axes are clean at `bd3ba9db5a0463fb52ff4711144c6db235142ca4`, author final `ee7adb1aaa062d37cf676421d17a9b75c41d7da3` is evidence-only. Dedicated integrated `pnpm verify` passed651 unit/integration tests,17 ordinary browsers,one signed-OIDC journey,formatting/types/builds. YAML/27 shell steps and MJS syntax also passed. Native nine-case local skips are not PostgreSQL evidence; this explicit release exception allows dependent implementation only when its other ticket prerequisites are also satisfied.

BOT-04-E1 closed by [Verify33948405362](https://github.com/Blackman99/openbot/actions/runs/33948405362), all six jobs successful on remote `fa79a3dd85baf0dd2acf888d5f39a2a071d83fd8`, completed2026-09-05 at05:57:03 UTC. The published tree `040312fdf38cea26574dddc06a343b46d417d977` exactly matches local `86bdf75fa7b5b392f41af85e856b01e775991185`, verified by fetch and pinned diff. The dedicated postgres-bots job101258691651 executed the eight identity and nine ACL cases in separate successful commands. Compose job101258691734 passed fresh/upgrade startup, precise visibility and ACL role/delete privileges, and all prior application/outage checks; code, postgres-auth, postgres-providers and postgres-oidc also passed. This closes the external gate without counting local skips as execution; fifteen tickets are fully complete.

## Open external gate — BOT-02-E1

- [ ] Execute the eight `bot-avatars-runtime.test.ts` cases against actual PostgreSQL using the deployed restricted role, preserving the preceding identity and ACL suites in separate serial commands.
- [ ] Execute the shared local/S3 immutable save/read/replace/delete contract and unsigned-read denial against the private S3-compatible fixture (six actual S3 cases).
- [ ] Execute fresh/upgrade Compose through0013, exact object/reference privileges, the runtime-user private-volume roundtrip and actual Alpine Sharp decoder; preserve all earlier checks.

BOT-02 integrated as `9eb8f89c78afdca995280f2cbbb53784e2901027`, tree `4c1c7aaca906a9c0122c75bb6ee229b8c6473b26`. Both independent review axes are CLEAN at final `7466346f3b45ff1857f3d7d5de6fdebd2af22265`; the sole P3 unknown-outcome message was fixed and independently rechecked. The dedicated merged full `pnpm verify` exited0:704 unit/integration tests (API88unit+260integration, Web35unit+321integration),18 ordinary browsers and one signed-OIDC journey,formatting/types/builds. Root independently reviewed the three-file additive integration delta preserving both route families, exact BOT-04 grants, three serial Bot native commands and the S3 job. Frozen install, YAML/34 Bash steps/two embedded JS blocks/MJS syntax passed. Native PostgreSQL eight cases, actual S3 six cases and Compose remain the explicit BOT-02-E1 release gate; local skips are not execution evidence.
