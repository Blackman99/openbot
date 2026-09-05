# BOT-03 implementation evidence

Base `f0f9383fd299873134f332962d4c14f55b38fdd8`; isolated `ticket/bot-03`. This is an incremental checkpoint, not final acceptance or an external service pass.

## API tracer

The first real Fastify edit/history/compare test returned404 before implementation. It now passes through the actual pg-mem repository seam: configuration changes append an immutable version, preserve defaults and instruction formatting, list safe author/time/rationale metadata, read original configuration unchanged, and produce exact scalar field differences and safe mandatory audit metadata. Existing seven avatar API tests remain green with the expanded shared append primitive.

A stale restore initially tried to resolve the requested source and returned404. A current-version check during preparation now returns409 first; the shared final append repeats CAS after any avatar I/O. The restore test then verifies appended versions3/4, no pointer rewind/renumber/delete, and restoredFromVersionId audit provenance, including an explicit identical-configuration restore.

A model-unavailable fixture initially referenced a nonexistent enabled SQL column; that fixture/setup mistake is not TDD evidence. It was corrected to use the real ProviderConnections.disable boundary. Tests verify unrelated edits succeed with the unavailable unchanged binding, while explicit binding edits and all restores fail fresh admission; historical reads remain available without provider admission.

Initial focused gate: three version API tests plus seven existing avatar API tests (10 passed), API TypeScript passed. No browser, native PostgreSQL or external service evidence is claimed at this checkpoint. UI, additional authority/fault coverage, native races/rollback, complete local gates and independent reviews follow.

## API authority, history and native-definition checkpoint

Ten version API tests pass, including a real ephemeral loopback HTTP request, strict public patch/rationale/precondition rejection, edit-before-no-op CAS, bounded descending history pagination, cross-Bot history/compare/restore refusal, explicit inspection/edit roles, workspace removal, no workspace-admin bypass, actual retained avatar reads through restoration, missing-image controlled failure, post-I/O permission revocation, and fresh exact-accessible-verified model admission. Invalid JSON fixture requests initially omitted their Content-Type and returned415; fixing the fixture header is setup correction, not behavior RED→GREEN evidence.

`bot-versions-runtime.test.ts` defines nine real PostgreSQL cases with the deployed restricted role: simultaneous edit-vs-restore CAS, queued edit/restore actor revocation with observed pg_blocking_pids, mandatory-audit rollback including restored avatar references, fresh model disabled/identity/Basic state after waiting on the provider scope lock, retained history references through cleanup, and timestamps sampled after final successful admission. It runs as a fourth independent Bot native command after the existing three, so fixed-role credential/grant provisioning cannot race. The S3 job and published migration0013 are unchanged. No migration or additional grants were introduced.

Local native registration reports all nine cases skipped because TEST_BOT_DATABASE_URL is absent. A newly added timestamp case was initially outside the skipped describe block; its ReferenceError and type diagnostics were corrected by restoring the proper suite scope. No native operation/provisioner ran locally, and no native behavior pass or native RED→GREEN is claimed. API TypeScript and formatting pass for this checkpoint.

## Strict client and final publication boundary

The strict Web client checkpoint `79ec226d91d0966f33cbdf9725f4d8e77ff05d69` is integrated. An eleventh API test uses that client against the actual loopback HTTP server for historical inspection, partial edit, explicit model selection, ordinary no-op, stale conflict, history cursor pagination, field comparison, restore and unauthenticated access. All 11 API version tests pass, and API TypeScript passes. The preceding complete API integration run passed 34 files / 270 tests; the newly added client test was then run in the focused gate.

The native definition now registers 11 cases, adding both stale-version and revoked-editor checks after actual historical-avatar reading finishes but before final restore publication. A bounded image-reader barrier verifies that a concurrent edit can finish while object I/O is paused, and the final transaction is observed waiting on the workspace lock before rechecking its precondition and current authority. All 11 cases remain explicitly skipped locally without TEST_BOT_DATABASE_URL; these definitions do not constitute actual PostgreSQL execution evidence.

## Browser interface source checkpoint

The isolated Web author supplied client `79ec226` and page source `b7b346f`, integrated as `23b08a1` and `f2148f7`. Four pages cover configuration editing, descending history, saved configuration with restoration, and field comparison including authenticated historical avatars. Bot detail navigation respects independent inspection/edit roles. Model selection defaults to Keep current model; only deliberate selection sends modelBinding, and unavailable failed selections remain explicit rather than silently switching back. Conflict and ambiguous transport outcomes retain the draft and original precondition, block resubmission, and instruct users to reload. Public forms never accept avatar object IDs.

The Web author witnessed request/parser/page RED→GREEN and an additional missing-modelChoice regression (the incomplete form previously redirected as if Keep were selected, now returns400 without issuing an API mutation). Their focused gate passed 66 tests: 26 strict-client, 11 version-route, seven rendered-page and 22 existing Bot-route cases. After integration, this worktree's Web typecheck independently reports zero errors and zero warnings. Browser journeys and full verification remain pending at this source checkpoint.

Workflow parsing succeeds and confirms four separate serial Bot native test commands plus the retained object-storage job. No external database, S3 or Compose run is claimed by these local checks.

## Final source verification and independent reviews

Source pin `a49413b010498a2309304c9a4798374bbf1fa46f`, tree `723f0ca056fc0e1f551123147984cad16dfe6b2d`, was verified on 2026-09-05. The three new Chromium journeys passed on their first targeted run (24.4 seconds), then complete `pnpm verify` exited 0 with no intervening source changes:

| Gate                                  | Result                                           |
| ------------------------------------- | ------------------------------------------------ |
| Formatting and API/Web types          | Passed; Web has zero errors and zero warnings    |
| API unit / integration                | 88 / 271 passed                                  |
| Web unit / integration                | 42 / 358 passed                                  |
| Combined unit / integration           | 759 passed                                       |
| Ordinary Chromium suite               | 21 passed, including all three BOT-03 journeys   |
| Signed OIDC Chromium suite            | One passed                                       |
| API and Web production builds         | Passed                                           |
| Native BOT-03 PostgreSQL registration | 11 explicitly skipped locally; actual CI pending |

Full local log: `/tmp/openbot-bot03-verify.log`. Both leased loopback ports, 4399 and 4173, were independently checked after completion and returned ECONNREFUSED; the lease was released to root. The implementation worktree was clean before these final evidence-only changes.

Root reports both independently assigned Standards and Specification reviews CLEAN at the exact source pin above. The Specification reviewer additionally ran 18 focused API tests. No source or fixture changes followed those reviews. This records distinct independent reviews, not the implementation author's self-inspection.

| Acceptance criterion                              | Implementation and evidence                                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Immutable configuration/avatar changes            | Shared append applies strict configuration patches and retains same-Bot avatar references; API history/reference tests and the first browser journey preserve originals                                                              |
| Strict current-version precondition               | CAS precedes no-op and source inspection, then repeats after avatar I/O; API returns 409, stale browser drafts retain the original precondition, and native race definitions cover final publication                                 |
| Author/time/rationale and field differences       | Paginated history, saved-version and comparison pages expose all 13 scalar fields, with authenticated avatar previews; exact API comparisons and browser field assertions pass                                                       |
| Restore appends a new version                     | Shared append allocates a new ID and next sequence, preserves all history, and audits safe source provenance; API and browser restoration tests pass                                                                                 |
| Fresh model access and capability admission       | Explicit binding edits and every restore re-admit within the SQL transaction, including exact model identity; unrelated edits retain an unavailable unchanged binding, with API/browser coverage and native queued-state definitions |
| Integration, browser and mandatory audit coverage | Real HTTP plus strict client integration, three new Chromium journeys, safe audit metadata checks, and native rollback/CAS/current-actor/reference cases are included                                                                |

No migration, new runtime grant, provider network call or root/global metadata mutation was needed. The sole workflow change runs the new native file as the fourth separate Bot command, preserving existing avatar/S3/Compose gates. Dedicated merged verification and real CI service outcomes remain root-owned acceptance steps. The local PostgreSQL skips and mocked browser fixture are not substitutes for native PostgreSQL, actual S3 or Compose execution.

## Latest integrated evidence

BOT-03 integrated as `82d5d911fdcf1e7a9f17b62023f776fd694246af`, tree `ddd5bea851c863d1f95718da5b363ac399f0f4de`. Both independent review axes are CLEAN at source `a49413b010498a2309304c9a4798374bbf1fa46f`; author final `6192dd3585e730192081de4bcde4174941d81f6c` changes only ticket/evidence documents. Dedicated merged pnpm verify exited0 with813 unit/integration tests (API88+289,Web47+389),24 ordinary browsers and one signed-OIDC journey,formatting,zero-error/zero-warning types and both builds. Root independently reviewed the four shared integration files: additive version service/routes, fourth serial native command and browser fixture;26 other candidate paths match exactly. No new domain correction was required. The11 actual PostgreSQL version cases remain BOT-03-E1 in REL-01 pending CI; local skips are not execution.
