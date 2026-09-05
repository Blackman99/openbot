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

## Closed external gate — BOT-02-E1

- [x] Execute the eight `bot-avatars-runtime.test.ts` cases against actual PostgreSQL using the deployed restricted role, preserving the preceding identity and ACL suites in separate serial commands.
- [x] Execute the shared local/S3 immutable save/read/replace/delete contract and unsigned-read denial against the private S3-compatible fixture (six actual S3 cases).
- [x] Execute fresh/upgrade Compose through0013, exact object/reference privileges, the runtime-user private-volume roundtrip and actual Alpine Sharp decoder; preserve all earlier checks.

BOT-02 integrated as `9eb8f89c78afdca995280f2cbbb53784e2901027`, tree `4c1c7aaca906a9c0122c75bb6ee229b8c6473b26`. Both independent review axes are CLEAN at final `7466346f3b45ff1857f3d7d5de6fdebd2af22265`; the sole P3 unknown-outcome message was fixed and independently rechecked. The dedicated merged full `pnpm verify` exited0:704 unit/integration tests (API88unit+260integration, Web35unit+321integration),18 ordinary browsers and one signed-OIDC journey,formatting/types/builds. Root independently reviewed the three-file additive integration delta preserving both route families, exact BOT-04 grants, three serial Bot native commands and the S3 job. Frozen install, YAML/34 Bash steps/two embedded JS blocks/MJS syntax passed. Native PostgreSQL eight cases, actual S3 six cases and Compose remain the explicit BOT-02-E1 release gate; local skips are not execution evidence.

BOT-02-E1 closed by [Verify33950565666](https://github.com/Blackman99/openbot/actions/runs/33950565666), all eight jobs successful on remote `6a611f9b0fe78b666fe63ab3c601a376c415fddd`, completed2026-09-05 at06:45:58 UTC. Published tree `065c73a6fe52d5f88cfd2abe520e94fb2d1c9fb2` exactly matches accepted local `3351d411a316652c7d698be1583ffa23d6050da5`, verified by fetch and pinned diff. The object-storage job101264648438 executed all six original real-S3 cases and seven private local-store cases successfully after the connection-pooling correction; temporary diagnostics and automatic retries are absent. The postgres-bots job101264648426 passed identity8,ACL9,avatar8 in three separate commands. Compose job101264648429 passed fresh/upgrade through0014, exact object/reference and conversation grants, actual Alpine Sharp loading, private runtime-volume roundtrip/ownership and all previous application/outage checks. Code and all five PostgreSQL jobs also passed. This closes the avatar release gate on actual services; seventeen tickets are now fully complete.

## Closed external gate — COL-03-E1

- [x] Execute all ten `conversations-runtime.test.ts` cases against actual PostgreSQL with the deployed role, including concurrent idempotency/order/edit CAS, required audit/dependent-write rollback, current admission and exact immutable-ledger privileges.
- [x] Execute fresh/upgrade Compose through0014 with conversation last_sequence-only UPDATE and event/subject guard privileges, preserving all prior avatar/ACL/provider/auth checks.

COL-03 integrated as `d559da23b4ae19429304f3a124f93f187025df42`, tree `26dc19629b52d56076128aeb7b64538a7fb6c396`. Both independent review axes are CLEAN at source `e599f4ca96474a47c59dfe140bb9e29f2b7547fa`; final author `3a3511e342978dfe9f607d33a77062202e6fd7e7` adds only evidence. Dedicated integrated full `pnpm verify` exited0:755 unit/integration tests (API88unit+275integration, Web40unit+352integration),21 ordinary browsers and one signed-OIDC journey,formatting/types/builds. Root independently reviewed the seven-file additive integration delta; conversation core/source tests match the reviewed candidate exactly. YAML/36 Bash steps/two embedded JS/three MJS syntax checks passed. Native PostgreSQL ten cases and actual Compose remain the explicit COL-03-E1 release gate.

COL-03-E1 closed by [Verify33949842135](https://github.com/Blackman99/openbot/actions/runs/33949842135), completed2026-09-05 at06:30:19 UTC on remote `990895839c34523aea53e80b8cd007925f785aa3`. Its tree `46791daf51c6b6b91e357cf120978b7e182129c9` exactly matches accepted local `2279a31eb7e23708ae464a2ec1e73e11e1adca73`, verified by fetch and pinned diff. Code passed764 unit/integration tests and22 browser scenarios. Dedicated postgres-conversations job101262649188 executed all10 cases successfully using the deployed restricted role. Compose job101262649137 passed fresh/upgrade through0014, last_sequence-only UPDATE, append-only event/subject guard privileges and all prior runtime/application/outage checks. All five PostgreSQL jobs succeeded. The overall workflow failed only its separate object-storage job, so this closes the scoped conversation gate but does not close BOT-02-E1 or claim a green overall workflow.

## Avatar service retry remains required

BOT-02 Verify33948926135 on remote `1d46acbeafea4df02ecb72b071955bedc68f69cf` completed2026-09-05 at06:09:49 UTC with the object-storage job failing. Code and all four PostgreSQL jobs passed; postgres-bots executed identity8,ACL9,avatar8 cases successfully. Compose passed migration0013, actual Alpine Sharp loading and the private runtime-volume roundtrip/ownership checks plus prior application/outage checks. Real S3 passed five of six cases; the shared concurrent-save case confirmed exactly one successful save and one object-already-exists result, then its following GET failed with safe object_store_unavailable at contract line57. No overwrite assertion failed. BOT-02-E1 remains open; isolated diagnosis is in .worktrees/ci-s3-contract. Do not count the partial S3 run as a passed storage gate.

## Closed external gate — BOT-03-E1

- [x] Execute all11 bot-versions-runtime.test.ts cases against actual PostgreSQL using the deployed restricted role: edit/restore CAS, waiting permission revocation, mandatory-audit rollback, exact fresh provider admission, retained avatar references and post-I/O revalidation.
- [x] Preserve the preceding identity, ACL and avatar native files as three separate serial commands, followed by the new version suite.
- [x] Keep all existing S3, PostgreSQL and fresh/upgrade Compose checks green on the integrated version revision; no migration or broader grant is introduced.

BOT-03 integrated as `82d5d911fdcf1e7a9f17b62023f776fd694246af`, tree `ddd5bea851c863d1f95718da5b363ac399f0f4de`. Both independent review axes are CLEAN at source `a49413b010498a2309304c9a4798374bbf1fa46f`; author final `6192dd3585e730192081de4bcde4174941d81f6c` changes only ticket/evidence documents. Dedicated merged pnpm verify exited0 with813 unit/integration tests (API88+289,Web47+389),24 ordinary browsers and one signed-OIDC journey,formatting,zero-error/zero-warning types and both builds. Root independently reviewed the four shared integration files: additive version service/routes, fourth serial native command and browser fixture;26 other candidate paths match exactly. No new domain correction was required. The11 actual PostgreSQL version cases remain BOT-03-E1 in REL-01 pending CI; local skips are not execution.

Actual gate closed by [Verify33956965487](https://github.com/Blackman99/openbot/actions/runs/33956965487), all nine jobs successful on2026-09-05 at09:07:34 UTC. See [actual native/Compose and commit-tree evidence](../VERIFY-33956965487.md); this supersedes the historical pending notes above.

## Closed external gate — COL-02-E1

- [x] Execute all14 group-bots-runtime.test.ts cases against actual PostgreSQL using the deployed restricted role: exact grants and immutable provenance, concurrent cap/duplicate handling, current authority and both revocation orderings, atomic audit/event rollback, retained history bounds and permanent closure.
- [x] Execute fresh/upgrade Compose through0015, checking precisely the four grant closure UPDATE columns and guard privileges while preserving all previous service/application checks.
- [x] Keep the dedicated postgres-group-bots job isolated from the other fixed-role database suites and retain the four serial Bot identity/ACL/avatar/version commands.

COL-02 integrated as28ce290e994f769219eb16b17565eb589dc12e16, tree1cdf7746ad50b61500a3b9ccc657ebbc066f84b9. Both independent review axes are CLEAN at final source3a297f9a94e33aaf5830a1cb17a77d6edee103ad; author finalaa08422d8b501fd0944f3e2d3faaf8062ae8fd84 adds only evidence. Dedicated merger full pnpm verify exited0:867 unit/integration tests (API88+302,Web52+425),26 ordinary browsers and one signed OIDC, formatting, zero-error/zero-warning types and both builds. Four additive shared integration files were independently reviewed;34 other candidate paths match exactly. No feature correction was needed. Local14 native skips are not service evidence. This explicit release gate permits COL-04 andATT-01 implementation because their other prerequisites are satisfied.

Actual gate closed by [Verify33956965487](https://github.com/Blackman99/openbot/actions/runs/33956965487), all nine jobs successful on2026-09-05 at09:07:34 UTC. See [actual native/Compose and commit-tree evidence](../VERIFY-33956965487.md); this supersedes the historical pending notes above.

## Closed external gate — BOT-05-E1

- [x] Execute all17 bot-copy-runtime.test.ts cases against actual PostgreSQL using the deployed restricted role, including source CAS/current actor admission, private sole-owner creation, model replacement, retained avatar reference and cleanup ordering, audit rollback, and queued source deletion.
- [x] Preserve serial identity8, ACL9, avatar8, version11 and lifecycle24 native commands before copy.
- [x] Keep actual S3 and fresh/upgrade Compose checks green on the accepted copy/lifecycle snapshot.

BOT-05 copy-only source4257bdf was independently CLEAN on Standards and Spec againstc389f993. It was integrated as0d641dba after accepted fullBOT-06. The dedicated combined pnpm verify passed969 unit/integration tests (API88+328, Web61+492),32 ordinary browser scenarios, one signed-OIDC journey, formatting, zero-error/zero-warning types and both builds. Root independently reviewed the exact two integration resolutions. Local17 native skips are not service evidence.

Actual gate closed by [Verify33956965487](https://github.com/Blackman99/openbot/actions/runs/33956965487), all nine jobs successful on2026-09-05 at09:07:34 UTC. See [actual native/Compose and commit-tree evidence](../VERIFY-33956965487.md); this supersedes the historical pending notes above.

## Closed external gate — BOT-06-E1

- [x] Execute all24 bot-lifecycle-runtime.test.ts cases against actual PostgreSQL using the deployed restricted role: exact privileges, current owner/workspace admission, concurrent/no-op transitions, fixed grace deadline, post-provider-wait expiry, required audit rollback and historical direct/group boundaries.
- [x] Execute fresh/upgrade Compose through actual0016, checking exactly current_version_id, visibility and the four lifecycle UPDATE columns while all identity/creation/workspace and table-wide mutation guards remain denied.
- [x] Preserve existing native, S3 and application/runtime/outage checks; this lifecycle ticket does not physically purge retained records or objects.

BOT-06 final source8392549 and author evidencef0e7731 were accepted asae567149 after both review axes were CLEAN. The combined full gate is pinned0d641dba/tree5b6bff829f4c12bc11ffe9c7963aba559dfef6d8. Reviewed CI-only follow-up4b4b553/tree6fde8ad53eedcb9b30def0b1b5a9297f7ff3f8be updates two missed Compose expectations; scoped YAML, affected shell scripts, full migration-list/schema/grant comparison, formatting and unchanged-negative-guard checks passed. Actual24 native cases and deployed Compose remain unexecuted in this local evidence.

Actual gate closed by [Verify33956965487](https://github.com/Blackman99/openbot/actions/runs/33956965487), all nine jobs successful on2026-09-05 at09:07:34 UTC. See [actual native/Compose and commit-tree evidence](../VERIFY-33956965487.md); this supersedes the historical pending notes above.

## Closed external gate — COL-04-E1

- [x] Execute all26 tasks-runtime.test.ts cases using the deployed restricted PostgreSQL role: immutable Task/Run/output guards, current actual-human and exact-grant admission, observed concurrent command/claim/finish barriers, audit rollback, retained provider identity/usage, response locator and expired/stale claim fencing.
- [x] Execute the separate compose-tasks job: keyless worker leaves durable queued work intact; configured worker runs with API/Web stopped; actual persisted running, completed and failed attempts and exactly one final Bot response survive API/worker restart.
- [x] Keep fresh/upgrade Compose through0017, exact Task/Run table/column/guard privileges, all prior Bot/conversation/auth/provider native cases and the six prior real S3 checks green.

Both independent review axes are CLEAN at1f68e42; final3505791 adds only evidence. Dedicated merge4627c692/tree030bc879 passed the complete pnpm verify:1039 unit/integration,35 ordinary browsers and one signed OIDC, formatting, types and final builds. Its four shared integration files were independently reviewed;63 candidate and32 root changed files retain exact blobs. No native PostgreSQL or Docker service was started locally. This explicit release gate permits the recorded dependent implementation frontier while actual service CI remains required.

Actual Verify33958220385 on remote60afa3b3 completed2026-09-05 at09:34:38 UTC with10 jobs successful and one native assertion failure. General Compose through0017 and separate worker seed/running/reloaded stages passed. Native Task25/26 passed; one assertion incorrectly counted the existing conversation.created audit. Independently reviewed test-only correction483ba992 is integrated asc653bab; production and duplicate/race assertions are unchanged.

COL-04-E1 closed by [Verify33959031255](https://github.com/Blackman99/openbot/actions/runs/33959031255), completed on 2026-09-05 at 09:54:57 UTC on published `2dab3fc280654257ba5a516c207ab8e2ba929e6a`. The checkout tree matches accepted local `675fd53c0ac098abac05a1560ce339abd7ae9df1`. PostgreSQL job101287771356 executed all 26 Task cases successfully; job101287771360 passed separate-worker seed/running/reloaded stages; general Compose job101287771315 passed fresh/upgrade through0018 and exact grants. All eight native jobs and the six prior real-S3 cases passed. The newly added large attachment S3 timeout remains only ATT-01-E1. See [actual execution and tree evidence](../VERIFY-33959031255.md); this supersedes the earlier pending Task notes.

## Open external gate — ATT-01-E1

- [x] Execute all5 attachments-runtime.test.ts cases using actual PostgreSQL and the deployed restricted role, including scope/history/immutability, rollback, blocked cleanup eligibility and active staged-write fencing.
- [ ] Keep the real private S3-compatible storage contract green with no automatic retry or assertion weakening.
- [x] Execute fresh/upgrade Compose through0018 and infra/verify-attachments.mjs under the deployed runtime role/private volume: exact upload/message receipt, private read/download, denied cross-scope reads and acknowledged original/derived object purge. Preserve every prior native, worker, storage and outage check.

Both source review axes and dedicated integration are CLEAN. Merge0bbaf856/tree4ec3bdd6 passed the full1,062 nonbrowser tests,36 ordinary browsers and one OIDC, formatting, zero-error/zero-warning types and builds. No local PostgreSQL or Docker was provisioned; external skips are not passes. This explicit gate permits dependent implementation when their other prerequisites are accepted.

[Verify33959031255](../VERIFY-33959031255.md) passed PostgreSQL attachment job101287771344 (5/5 actual cases) and general Compose job101287771315, including the durable original/derived object purge marker at 09:54:43.3042123 UTC on 2026-09-05. Only the new real-S3 case `keeps attachment and avatar byte bounds independent on the real backend` remains open: object-storage job101287771358 reported a 5,000 ms timeout and 7,823 ms case duration; its other seven local and six real-S3 cases passed. Independently reviewed correction `2cf2ea5b117af4eb35a7e6312776f97177bc6827`, integrated as `86c77c6ce50478703ee32c5a0fb7a05dce24775e`, changes only that case's test budget to 30,000 ms. Actual CI must pass the unchanged assertions before ATT-01-E1 closes; the fix itself is not execution evidence.

## Open external gate — API-02-E1

- [ ] Execute all 31 `public-bots-runtime.test.ts` cases with actual PostgreSQL and the deployed restricted role, proving scoped creator/workspace authority, same-transaction final admission, expiry and revocation after resource/provider/avatar/audit waits, no-op admission, immutable history and complete rollback.
- [ ] Run the native file as its own serial command after identity, ACL, avatar, version, lifecycle and copy suites, with a required nonempty `TEST_BOT_DATABASE_URL`; missing-URL discovery skips cannot satisfy this gate.

API-02 source `18ad24f06dd8a5afe2b795462975d186a0650487` passed both independent review axes. Accepted merge `bdaa32526383739243a227a7c5023a4c8b3e7ffd`, tree `b2a174630bef5616d6a8dc7140adf349d50f6fde`, passed the explicitly recorded composite gate: 1,075 nonbrowser tests, 37 ordinary browsers including the actual public API/Svelte round trip, one signed OIDC journey, formatting, types and final builds. Initial `pnpm verify` exited 1; the reviewed fixture-only reset correction passed the complete remaining browser/build gate. All 31 native cases were skipped locally, with zero executed. Verify33959031255 predates this ticket. See [integration evidence](../API-02-INTEGRATION.md) and [native coverage](../API-02-NATIVE-EVIDENCE.md).
